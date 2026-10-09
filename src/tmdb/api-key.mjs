import { fetch as runtimeFetch, Storage } from "../runtime/script.mjs";

// 脚本端本地缓存的 API Key 存储键与远端拉取有效期。
const API_KEY_STORAGE_KEY = "dj_tmdb_proxy_api_key";
const API_KEY_TTL_MS = 6 * 60 * 60 * 1000;
// 脚本端拉取 key 的超时兜底，避免宿主在 done() 后终止脚本导致更新丢失。
const REFRESH_TIMEOUT_MS = 2000;

// 读取环境变量中的 TMDB API Key（反代由后端环境变量提供）。
function getTmdbApiKey(env) {
	const value = env?.TMDB_API_KEY ?? globalThis.process?.env?.TMDB_API_KEY;
	const key = typeof value === "string" ? value.trim() : "";
	return key || undefined;
}

// 脚本运行时（Surge/Loon/QX）由宿主提供 $done/$response，反代与 Node 运行时没有。
function isScriptRuntime() {
	return typeof $done !== "undefined" || typeof $response !== "undefined";
}

// TMDB API Key 提供者：环境变量优先，脚本端回退到本地缓存与缓存后端下发的最新 key。
class TmdbApiKeyProvider {
	constructor({ env, backendUrl, storage, now } = {}) {
		this.envKey = getTmdbApiKey(env);
		this.backendUrl = backendUrl ? String(backendUrl).trim().replace(/\/+$/, "") : "";
		this.storage = storage ?? Storage;
		this.now = now;
		this.pending = null;
	}

	// 仅脚本端需要远端拉取：反代已有环境变量，Node 运行时没有宿主持久化能力。
	_canFetchRemote() {
		return !this.envKey && Boolean(this.backendUrl) && isScriptRuntime();
	}

	_readCached() {
		const entry = this.storage?.getItem(API_KEY_STORAGE_KEY, null);
		const key = typeof entry?.key === "string" ? entry.key.trim() : "";
		if (!key) return undefined;
		return entry.expiresAt > (this.now ?? Date.now()) ? key : undefined;
	}

	_writeCached(key) {
		this.storage?.setItem(API_KEY_STORAGE_KEY, { key, expiresAt: (this.now ?? Date.now()) + API_KEY_TTL_MS });
	}

	// 判断失效的 key 是否由本提供者注入：只有自己注入的 key 失效才需要向后端刷新。
	isOwnKey(key) {
		if (!key) return false;
		return key === (this.envKey ?? this._readCached());
	}

	// 获取当前可用 key：环境变量 → 本地缓存 → 向后端拉取。
	async get() {
		if (this.envKey) return this.envKey;
		if (!this._canFetchRemote()) return undefined;
		return this._readCached() ?? (await this.refresh());
	}

	// 向缓存后端拉取最新 key，并发调用共用同一次请求。
	async refresh() {
		if (!this._canFetchRemote()) return this.envKey;
		if (this.pending) return this.pending;
		this.pending = (async () => {
			try {
				const response = await runtimeFetch({
					url: `${this.backendUrl}/key`,
					method: "GET",
					headers: { Accept: "application/json" },
				});
				if (!response?.ok && !(response?.status >= 200 && response?.status < 300)) return undefined;
				const payload = JSON.parse(response.body ?? "{}");
				const key = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
				if (!key) return undefined;
				this._writeCached(key);
				return key;
			} catch (error) {
				console.warn("[tmdb-proxy] 拉取远端 API Key 失败", error?.message ?? error);
				return undefined;
			} finally {
				this.pending = null;
			}
		})();
		return this.pending;
	}

	// TMDB 返回 401 表示 key 已失效或轮换：清掉本地缓存并立即拉取最新 key。
	async handleUnauthorized(waitUntil) {
		if (this.envKey) return this.envKey;
		this.storage?.setItem(API_KEY_STORAGE_KEY, null);
		const pending = this.refresh();
		if (typeof waitUntil === "function") waitUntil(pending);
		if (!isScriptRuntime()) return await pending;
		return await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(undefined), REFRESH_TIMEOUT_MS))]);
	}
}

function createTmdbApiKeyProvider(options) {
	return new TmdbApiKeyProvider(options);
}

export { createTmdbApiKeyProvider, getTmdbApiKey };
