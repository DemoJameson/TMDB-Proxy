import { Hono } from "hono";
import { Redis } from "@upstash/redis";
import HonoWorkerAdapter from "./class/HonoWorkerAdapter.mjs";
import { Request } from "./process/Request.mjs";
import { Response } from "./process/Response.mjs";
import { RedisCacheStore } from "./tmdb/cache-redis.mjs";
import { fireCacheWrite } from "./tmdb/cache-store.mjs";
import { injectTmdbCredential } from "./tmdb/proxy.mjs";
import { fetchUpstream } from "./tmdb/request-rules.mjs";

// 模块级初始化（Worker isolate 复用）。
// Module-level initialization (reused across Worker isolate).
let cacheStore = null;
function initCacheStore(env) {
	if (cacheStore) return cacheStore;
	// 兼容两套环境变量命名：Upstash 官方（UPSTASH_REDIS_REST_*）和 Vercel KV 集成（KV_REST_API_*）。
	// Support both naming conventions: Upstash official (UPSTASH_REDIS_REST_*) and Vercel KV integration (KV_REST_API_*).
	const url = env?.UPSTASH_REDIS_REST_URL ?? env?.KV_REST_API_URL ?? globalThis.process?.env?.UPSTASH_REDIS_REST_URL ?? globalThis.process?.env?.KV_REST_API_URL;
	const token = env?.UPSTASH_REDIS_REST_TOKEN ?? env?.KV_REST_API_TOKEN ?? globalThis.process?.env?.UPSTASH_REDIS_REST_TOKEN ?? globalThis.process?.env?.KV_REST_API_TOKEN;
	// 未配置 Redis 时返回 null，proxy.mjs 会 fallback 到 BlobCacheStore(Storage)。
	// Returns null when Redis is not configured; proxy.mjs falls back to BlobCacheStore(Storage).
	cacheStore = url && token ? new RedisCacheStore(new Redis({ url, token })) : null;
	return cacheStore;
}

// 从 Hono context 提取 waitUntil（Cloudflare Workers 专用，Vercel/Node.js 上为 undefined）。
// Extract waitUntil from Hono context (Cloudflare Workers only; undefined on Vercel/Node.js).
function getWaitUntil(c) {
	return typeof c.executionContext?.waitUntil === "function" ? c.executionContext.waitUntil.bind(c.executionContext) : undefined;
}

// 缓存批量读取端点 —— 供脚本按需批量拉取指定条目。
// Cache batch read endpoint — for scripts to fetch specific entries on demand.
// POST /cache/get  body: { "movie": [550, 551], "tv": [1399] }  →  { "movie": { "550": {...} }, "tv": { "1399": {...} } }
async function handleCacheGet(c) {
	const store = initCacheStore(c.env);
	if (!store) return c.json({ movie: {}, tv: {} });
	const query = await c.req.json();
	const result = { movie: {}, tv: {} };
	for (const mediaType of ["movie", "tv"]) {
		const ids = Array.isArray(query?.[mediaType]) ? query[mediaType] : [];
		if (ids.length === 0) continue;
		const entries = await store.getMany(mediaType, ids.map(String));
		for (const [id, entry] of entries) result[mediaType][id] = entry;
	}
	return c.json(result);
}

// 缓存批量写入端点 —— 供脚本按需批量推送本地缓存条目。
// Cache batch write endpoint — for scripts to push local entries on demand.
// POST /cache/set  body: [{ "mediaType": "movie", "id": "550", "data": {...}, "ttlMs": 604800000 }, ...]
async function handleCacheSet(c) {
	const store = initCacheStore(c.env);
	if (!store) return c.json({ ok: false, error: "Redis not configured" }, 503);
	const entries = await c.req.json();
	if (Array.isArray(entries) && entries.length > 0) {
		await fireCacheWrite(store.setMany(entries), getWaitUntil(c));
	}
	return c.json({ ok: true });
}

/***************** Processing *****************/
export default new Hono()
	// 同时注册 /cache/* 和 /api/cache/* 路径，兼容 Cloudflare Workers（无 /api 前缀）和 Vercel（/api/* 前缀）。
	// Register both /cache/* and /api/cache/* to support Cloudflare Workers (no /api prefix) and Vercel (/api/* prefix).
	.post("/cache/get", handleCacheGet)
	.post("/api/cache/get", handleCacheGet)
	.post("/cache/set", handleCacheSet)
	.post("/api/cache/set", handleCacheSet)
	.all("/:rest{.*}", async c => {
		let $request = await HonoWorkerAdapter.buildRequest(c);
		if (!$request) return c.text("Not Found", 404);
		let $response;
		({ $request, $response } = await Request($request));
		switch (typeof $response) {
			case "object":
				console.debug("finally", `echo $response: ${JSON.stringify($response, null, 2)}`);
				return HonoWorkerAdapter.writeResponse(c, $response);
			case "undefined":
				console.debug("finally", `$request: ${JSON.stringify($request, null, 2)}`);
				injectTmdbCredential($request, c.env?.TMDB_ACCESS_TOKEN ?? globalThis.process?.env?.TMDB_ACCESS_TOKEN);
				$response = await fetchUpstream($request);
				$response = await Response($request, $response, { cacheStore: initCacheStore(c.env), waitUntil: getWaitUntil(c) });
				return HonoWorkerAdapter.writeResponse(c, $response);
			default:
				console.error(`不合法的 $response 类型: ${typeof $response}`);
				return c.body("", 500);
		}
	})
	.onError((e, c) => {
		console.error(`${e}`);
		return c.text(`${e}`, 500);
	});
