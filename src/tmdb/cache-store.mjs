import { getCacheEntry, isValidEntry, readCache, updateCacheEntry, writeCache } from "./cache.mjs";

// 抽象基类，统一缓存读写操作接口。
// Abstract base class providing a unified cache read/write interface.
class CacheStore {
	async get(mediaType, id, now) {}
	async getMany(mediaType, ids, now) {}
	// 按需获取：确保条目包含指定字段，本地缺失时回查远端。默认实现退化为 get。
	// On-demand fetch: ensure entry contains the requested fields; remote is queried when local lacks them. Default falls back to get.
	async getWithFields(mediaType, id, fields, now) {
		return this.get(mediaType, id, now);
	}
	async getManyWithFields(mediaType, ids, fields, now) {
		return this.getMany(mediaType, ids, now);
	}
	async set(mediaType, id, data, ttlMs, now) {}
	async setMany(entries, now) {}
	async merge(mediaType, id, partialData, ttlMs, now) {}
}

// 包装现有 Storage + cache.mjs（脚本和测试用）。
// Wraps existing Storage + cache.mjs for script runtime and tests.
class BlobCacheStore extends CacheStore {
	constructor(storage) {
		super();
		this.storage = storage;
	}
	async get(mediaType, id, now) {
		return getCacheEntry(readCache(this.storage), mediaType, id, now ?? Date.now());
	}
	async getMany(mediaType, ids, now) {
		const cache = readCache(this.storage);
		const timestamp = now ?? Date.now();
		const result = new Map();
		for (const id of ids) {
			const entry = getCacheEntry(cache, mediaType, id, timestamp);
			if (entry) result.set(String(id), entry);
		}
		return result;
	}
	async set(mediaType, id, data, ttlMs, now) {
		const cache = readCache(this.storage);
		const timestamp = now ?? Date.now();
		updateCacheEntry(cache, mediaType, id, data, timestamp, ttlMs);
		writeCache(this.storage, cache, timestamp);
	}
	async setMany(entries, now) {
		const cache = readCache(this.storage);
		const timestamp = now ?? Date.now();
		for (const { mediaType, id, data, ttlMs } of entries) updateCacheEntry(cache, mediaType, id, data, timestamp, ttlMs);
		writeCache(this.storage, cache, timestamp);
	}
	async merge(mediaType, id, partialData, ttlMs, now) {
		const cache = readCache(this.storage);
		const timestamp = now ?? Date.now();
		updateCacheEntry(cache, mediaType, id, partialData, timestamp, ttlMs);
		writeCache(this.storage, cache, timestamp);
	}
}

// 通过 HTTP 调用远端 /cache/get 和 /cache/set 端点的缓存实现。
// HTTP-based cache store that calls remote /cache/get and /cache/set endpoints.
class RemoteCacheStore extends CacheStore {
	constructor(remoteUrl, fetcher) {
		super();
		this.remoteUrl = remoteUrl ? String(remoteUrl).replace(/\/+$/, "") : "";
		this.fetcher = typeof fetcher === "function" ? fetcher : null;
	}

	async _post(path, body) {
		if (!this.remoteUrl || !this.fetcher) return null;
		try {
			const response = await this.fetcher({
				url: `${this.remoteUrl}${path}`,
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!response?.ok && !(response?.status >= 200 && response?.status < 300)) return null;
			return JSON.parse(response.body ?? "{}");
		} catch {
			return null;
		}
	}

	async get(mediaType, id) {
		const entries = await this.getMany(mediaType, [String(id)]);
		return entries.get(String(id)) ?? null;
	}

	async getMany(mediaType, ids) {
		if (!this.remoteUrl || !this.fetcher || ids.length === 0) return new Map();
		const result = await this._post("/cache/get", { [mediaType]: ids });
		const entries = result?.[mediaType] ?? {};
		const map = new Map();
		for (const [id, entry] of Object.entries(entries)) {
			if (isValidEntry(entry)) map.set(String(id), entry);
		}
		return map;
	}

	async set(mediaType, id, data, ttlMs) {
		await this.setMany([{ mediaType, id: String(id), data, ttlMs }]);
	}

	async setMany(entries) {
		if (!this.remoteUrl || !this.fetcher || entries.length === 0) return;
		await this._post("/cache/set", entries);
	}

	async merge(mediaType, id, partialData, ttlMs) {
		// 远端合并：先读后写，避免覆盖已有字段（如 characters）。
		// Remote merge: read-then-write to avoid overwriting existing fields (e.g. characters).
		const existing = (await this.getMany(mediaType, [String(id)])).get(String(id)) ?? {};
		const merged = { ...existing, ...partialData };
		await this.setMany([{ mediaType, id: String(id), data: merged, ttlMs }]);
	}
}

// 分层缓存：本地优先，未命中查远端，命中回写本地；写入时本地先写、远端 fire-and-forget。
// Tiered cache: local first, fallback to remote on miss and writeback; local writes awaited, remote writes fire-and-forget.
class TieredCacheStore extends CacheStore {
	constructor(local, remote) {
		super();
		this.local = local;
		this.remote = remote;
	}

	async get(mediaType, id, now) {
		// 1. 查本地
		// 1. Check local first
		const local = await this.local.get(mediaType, id, now);
		if (local) return local;
		// 2. 本地未命中，查远端
		// 2. On local miss, query remote
		const remote = await this.remote.get(mediaType, id, now);
		if (remote) {
			// 3. 远端命中，回写本地（fire-and-forget）
			// 3. Remote hit, writeback to local (fire-and-forget)
			this.local.set(mediaType, id, remote, remote.expiresAt - remote.createdAt, now).catch(() => {});
		}
		return remote;
	}

	async getMany(mediaType, ids, now) {
		// 1. 查本地，收集未命中
		// 1. Check local, collect misses
		const localEntries = await this.local.getMany(mediaType, ids, now);
		const misses = ids.filter(id => !localEntries.has(String(id)));
		if (misses.length === 0) return localEntries;
		// 2. 批量查远端
		// 2. Batch query remote for misses
		const remoteEntries = await this.remote.getMany(mediaType, misses, now);
		// 3. 远端命中回写本地（fire-and-forget）
		// 3. Writeback remote hits to local (fire-and-forget)
		const writeback = [];
		for (const [id, entry] of remoteEntries) {
			writeback.push({ mediaType, id, data: entry, ttlMs: entry.expiresAt - entry.createdAt });
		}
		if (writeback.length > 0) this.local.setMany(writeback, now).catch(() => {});
		// 4. 合并结果
		// 4. Merge results
		const result = new Map(localEntries);
		for (const [id, entry] of remoteEntries) result.set(id, entry);
		return result;
	}

	async set(mediaType, id, data, ttlMs, now) {
		// 本地先写（await），远端 fire-and-forget
		// Local write awaited, remote write fire-and-forget
		await this.local.set(mediaType, id, data, ttlMs, now);
		this.remote.set(mediaType, id, data, ttlMs, now).catch(() => {});
	}

	async setMany(entries, now) {
		// 本地先批量写（await），远端 fire-and-forget
		// Local batch write awaited, remote write fire-and-forget
		await this.local.setMany(entries, now);
		this.remote.setMany(entries, now).catch(() => {});
	}

	async merge(mediaType, id, partialData, ttlMs, now) {
		// 本地合并（await），远端合并 fire-and-forget
		// Local merge awaited, remote merge fire-and-forget
		await this.local.merge(mediaType, id, partialData, ttlMs, now);
		this.remote.merge(mediaType, id, partialData, ttlMs, now).catch(() => {});
	}

	// 判断条目是否已包含所有需要的字段（字段值非 undefined）。
	// Checks whether entry already contains all requested fields (field value is not undefined).
	static _hasFields(entry, fields) {
		if (!entry) return false;
		return fields.every(field => entry[field] !== undefined);
	}

	// 合并本地与远端条目：本地已有字段保留，远端填充本地缺失的字段。
	// Merges local and remote entries: local fields are kept, remote fills gaps in local.
	static _mergeEntries(local, remote) {
		const merged = { ...remote, ...local };
		const source = local ?? remote;
		return { merged, ttlMs: source.expiresAt - source.createdAt };
	}

	async getWithFields(mediaType, id, fields, now) {
		const local = await this.local.get(mediaType, id, now);
		if (TieredCacheStore._hasFields(local, fields)) return local;
		// 本地缺失字段，查远端
		// Local lacks some fields, query remote
		const remote = await this.remote.get(mediaType, id, now);
		if (!remote) return local;
		// 合并：本地保留，远端填充
		// Merge: keep local, fill from remote
		const { merged, ttlMs } = TieredCacheStore._mergeEntries(local, remote);
		this.local.set(mediaType, id, merged, ttlMs, now).catch(() => {});
		return merged;
	}

	async getManyWithFields(mediaType, ids, fields, now) {
		const localEntries = await this.local.getMany(mediaType, ids, now);
		// 收集本地缺失字段的 id
		// Collect ids where local lacks fields
		const misses = ids.filter(id => !TieredCacheStore._hasFields(localEntries.get(String(id)), fields));
		if (misses.length === 0) return localEntries;
		const remoteEntries = await this.remote.getMany(mediaType, misses, now);
		const writeback = [];
		const result = new Map(localEntries);
		for (const id of misses) {
			const local = localEntries.get(String(id));
			const remote = remoteEntries.get(String(id));
			if (!remote) continue;
			const { merged, ttlMs } = TieredCacheStore._mergeEntries(local, remote);
			writeback.push({ mediaType, id, data: merged, ttlMs });
			result.set(String(id), merged);
		}
		if (writeback.length > 0) this.local.setMany(writeback, now).catch(() => {});
		return result;
	}
}

// 脚本运行时（Surge/Loon/QX）有 $done/$response 全局变量，done() 后宿主会终止脚本。
// Script runtimes (Surge/Loon/QX) have $done/$response globals; host terminates the script after done().
function isScriptRuntime() {
	return typeof $done !== "undefined" || typeof $response !== "undefined";
}

// 将缓存写入包装为 fire-and-forget：错误静默吞掉，并在 Workers 上通过 waitUntil 保活。
// 脚本运行时无 waitUntil 时，等待写入完成（最多 2 秒），避免宿主终止脚本导致请求丢失。
// 反代服务器（Vercel/Node.js）是长期运行的进程，不需要等待，fire-and-forget 会自然完成。
// Wraps a cache write as fire-and-forget: swallows errors, uses waitUntil on Workers.
// On script runtime (no waitUntil, detected via $done/$response globals), awaits the write (max 2s) to ensure it completes.
// On server runtime (Vercel/Node.js), returns immediately — the process stays alive and writes complete naturally.
async function fireCacheWrite(promise, waitUntil) {
	if (!promise) return;
	const handled = promise.catch(() => {});
	if (typeof waitUntil === "function") {
		waitUntil(handled);
	} else if (isScriptRuntime()) {
		// 脚本运行时无 waitUntil，等待请求完成或超时（2 秒），确保 HTTP 请求在 done() 前发出。
		// Script runtime without waitUntil: await request completion or timeout (2s) to ensure HTTP request is sent before done().
		await Promise.race([handled, new Promise(resolve => setTimeout(resolve, 2000))]);
	}
}

export { BlobCacheStore, CacheStore, RemoteCacheStore, TieredCacheStore, fireCacheWrite };
