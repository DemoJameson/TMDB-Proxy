// 请求/响应头工具：大小写不敏感读写，供 request-rules、proxy、子请求构造共用。
// Request/response header utilities: case-insensitive read/write, shared by request-rules, proxy and sub-request builders.
const STATE_HEADER = "x-tmdb-proxy-state";

function readHeader(headers, key) {
	const lower = key.toLowerCase();
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
	}
	return undefined;
}

function setHeader(headers, key, value) {
	const lower = key.toLowerCase();
	for (const name of Object.keys(headers ?? {})) {
		if (name.toLowerCase() === lower) delete headers[name];
	}
	headers[key] = value;
}

function deleteHeader(headers, key) {
	const lower = key.toLowerCase();
	for (const name of Object.keys(headers ?? {})) {
		if (name.toLowerCase() === lower) headers[name] = undefined;
	}
}

// forwardinfo 专属请求头：鉴权（X-Signature/X-Timestamp）与 CDN 会话头对 TMDB 无效甚至有害（Host 会改写目标主机），子请求转发到 TMDB 前需移除（大小写不敏感）。
// forwardinfo-specific headers: auth (X-Signature/X-Timestamp) and CDN session headers are invalid or harmful at TMDB (Host would rewrite the target); strip before forwarding sub-requests (case-insensitive).
const FORWARD_ONLY_HEADER_NAMES = new Set(["authorization", "host", "cookie", "x-signature", "x-timestamp"]);

function buildSubRequestHeaders(sourceRequest, isForward) {
	return Object.fromEntries(
		Object.entries(sourceRequest.headers ?? {}).filter(([key]) => {
			const lower = key.toLowerCase();
			return lower !== STATE_HEADER && !(isForward && FORWARD_ONLY_HEADER_NAMES.has(lower));
		}),
	);
}

export { buildSubRequestHeaders, deleteHeader, readHeader, STATE_HEADER, setHeader };
