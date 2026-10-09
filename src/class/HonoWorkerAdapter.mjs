import { Lodash as _ } from "@nsnanocat/util";

/**
 * Hono 路由上下文类型。
 * @typedef {import("hono").Context} HonoContext
 */

/**
 * Worker 统一头部字典。
 * @typedef {Record<string, string | string[] | undefined>} WorkerHeaders
 */

/**
 * Worker 内部统一请求对象。
 * @typedef {{
 * 	method: string,
 * 	url: string,
 * 	headers: WorkerHeaders,
 * 	body?: ArrayBuffer,
 * 	bodyBytes?: ArrayBuffer,
 * }} WorkerRequest
 */

/**
 * Worker 内部统一响应对象。
 * @typedef {{
 * 	status?: number,
 * 	statusCode?: number,
 * 	headers?: WorkerHeaders,
 * 	body?: string | ArrayBuffer | Uint8Array | null,
 * 	bodyBytes?: ArrayBuffer | Uint8Array | null,
 * }} WorkerResponse
 */

/**
 * Hono Worker 运行时适配器。
 */
export default class HonoWorkerAdapter {
	/**
	 * 根据 Vercel/Workers 入口路径重写为 TMDB 上游 URL。
	 * @param {URL} url 当前请求 URL
	 * @param {string} restPath 回退路由路径
	 * @returns {URL | null} 重写后的 URL，非代理路径返回 null
	 */
	static routeRewrite(url, restPath = "") {
		const path = `${restPath}`.replace(/^\/+/, "");
		const tmdbPath = path.replace(/^api\//, "");
		// API 路径为 /3/...，图片路径为 /t/p/...；两者共用一个反代域名时在这里按路径分流。
		let hostname;
		if (tmdbPath.startsWith("3/")) hostname = "api.themoviedb.org";
		else if (tmdbPath.startsWith("t/p/")) hostname = "image.tmdb.org";
		else return null;
		url.protocol = "https:";
		url.hostname = hostname;
		url.port = "443";
		url.pathname = `/${tmdbPath}`;
		return url;
	}

	/**
	 * 解析请求查询参数，兼容旧入口中的点路径嵌套写法。
	 * @param {string} search URL 查询串
	 * @returns {Record<string, unknown>} 解析后的参数对象
	 */
	static parseRequestArguments(search = "") {
		globalThis.$argument ??= {};
		for (const [key, value] of new URLSearchParams(search).entries()) {
			_.set(globalThis.$argument, key, value);
		}
		return globalThis.$argument;
	}

	/**
	 * 清理并标准化转发请求头。
	 * @param {WorkerHeaders} headers 原始请求头
	 * @returns {WorkerHeaders} 标准化后的请求头
	 */
	static normalizeRequestHeaders(headers = {}) {
		const requestHeaderBlacklist = new Set(["connection", "content-length", "host", "x-forwarded-proto", "x-real-ip"]);
		return Object.entries(headers).reduce((normalizedHeaders, [key, value]) => {
			if (value === undefined) return normalizedHeaders;
			const normalizedKey = key.toLowerCase();
			if (normalizedKey.startsWith("cf-") || requestHeaderBlacklist.has(normalizedKey)) return normalizedHeaders;
			normalizedHeaders[key] = value;
			return normalizedHeaders;
		}, {});
	}

	/**
	 * 从 Hono context 构造内部统一请求对象。
	 * @param {HonoContext} c Hono 上下文
	 * @returns {Promise<WorkerRequest | null>} 标准化请求对象，非代理路径返回 null
	 */
	static async buildRequest(c) {
		const url = HonoWorkerAdapter.routeRewrite(new URL(c.req.url), c.req.param("rest"));
		if (!url) return null;
		const method = c.req.method;
		let bodyBytes;
		switch (method) {
			case "GET":
			case "HEAD":
			case "OPTIONS":
				break;
			default:
				bodyBytes = await c.req.arrayBuffer().catch(error => {
					console.info(error);
					return undefined;
				});
				if (!bodyBytes?.byteLength) bodyBytes = undefined;
				break;
		}
		const { arguments: argumentHeader, ...headers } = HonoWorkerAdapter.normalizeRequestHeaders(c.req.header());
		HonoWorkerAdapter.parseRequestArguments(argumentHeader);
		HonoWorkerAdapter.parseRequestArguments(url.search);
		Array.from(url.searchParams.keys()).forEach(key => {
			if (key.startsWith(".")) url.searchParams.delete(key);
		});
		return {
			method,
			url: url.toString(),
			headers,
			body: bodyBytes,
			bodyBytes,
		};
	}

	/**
	 * 清理回包头，避免与 Cloudflare Workers 回写行为冲突。
	 * @param {WorkerHeaders} headers 原始响应头
	 * @returns {WorkerHeaders} 清理后的响应头
	 */
	static cleanupResponseHeaders(headers = {}) {
		const normalizedHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !["content-length", "transfer-encoding"].includes(key.toLowerCase())));
		if (normalizedHeaders["Content-Encoding"]) normalizedHeaders["Content-Encoding"] = "identity";
		if (normalizedHeaders["content-encoding"]) normalizedHeaders["content-encoding"] = "identity";
		return normalizedHeaders;
	}

	/**
	 * 将内部统一响应对象写回 Hono response。
	 * @param {HonoContext} c Hono 上下文
	 * @param {WorkerResponse} $response 内部响应对象
	 * @returns {Response} Hono 响应
	 */
	static writeResponse(c, $response = {}) {
		const headers = HonoWorkerAdapter.cleanupResponseHeaders($response.headers ?? {});
		for (const [key, value] of Object.entries(headers)) {
			if (Array.isArray(value)) {
				for (const entry of value) c.header(key, entry.toString(), { append: true });
				continue;
			}
			if (value !== undefined) c.header(key, value.toString());
		}
		c.status($response.status ?? $response.statusCode ?? 200);
		return c.body($response.body ?? $response.bodyBytes ?? null);
	}
}
