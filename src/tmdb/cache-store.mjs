import { getCacheEntry, isValidEntry, readCache, updateCacheEntry, writeCache } from "./cache.mjs";

// 缓存操作失败仅记录警告，不影响主流程。
function warnCacheError(operation, error) {
	console.warn(`[tmdb-proxy] 缓存${operation}失败`, error?.message ?? error);
}

// 抽象基类，统一缓存读写操作接口。
class CacheStore {
	async get(_mediaType, _id, _now) {}
	async getMany(_mediaType, _ids, _now) {}
	// 按需获取：确保条目包含指定字段，本地缺失时回查远端。默认实现退化为 get。
	async getWithFields(mediaType, id, _fields, now) {
		return this.get(mediaType, id, now);
	}
	async getManyWithFields(mediaType, ids, _fields, now) {
		return this.getMany(mediaType, ids, now);
	}
	async set(_mediaType, _id, _data, _ttlMs, _now) {}
	async setMany(_entries, _now) {}
	async merge(_mediaType, _id, _partialData, _ttlMs, _now) {}
}

// 包装现有 Storage + cache.mjs（脚本和测试用）。
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
		} catch (error) {
			warnCacheError("远端读写", error);
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
		const existing = (await this.getMany(mediaType, [String(id)])).get(String(id)) ?? {};
		const merged = { ...existing, ...partialData };
		await this.setMany([{ mediaType, id: String(id), data: merged, ttlMs }]);
	}
}

// 分层缓存：本地优先，未命中查远端，命中回写本地；写入时本地先写、远端 fire-and-forget。
class TieredCacheStore extends CacheStore {
	constructor(local, remote) {
		super();
		this.local = local;
		this.remote = remote;
	}

	async get(mediaType, id, now) {
		// 1. 查本地
		const local = await this.local.get(mediaType, id, now);
		if (local) return local;
		// 2. 本地未命中，查远端
		const remote = await this.remote.get(mediaType, id, now);
		if (remote) {
			// 3. 远端命中，回写本地（fire-and-forget）
			this.local.set(mediaType, id, remote, remote.expiresAt - remote.createdAt, now).catch(error => warnCacheError("本地回写", error));
		}
		return remote;
	}

	async getMany(mediaType, ids, now) {
		// 1. 查本地，收集未命中
		const localEntries = await this.local.getMany(mediaType, ids, now);
		const misses = ids.filter(id => !localEntries.has(String(id)));
		if (misses.length === 0) return localEntries;
		// 2. 批量查远端
		const remoteEntries = await this.remote.getMany(mediaType, misses, now);
		// 3. 远端命中回写本地（fire-and-forget）
		const writeback = [];
		for (const [id, entry] of remoteEntries) {
			writeback.push({ mediaType, id, data: entry, ttlMs: entry.expiresAt - entry.createdAt });
		}
		if (writeback.length > 0) this.local.setMany(writeback, now).catch(error => warnCacheError("本地回写", error));
		// 4. 合并结果
		const result = new Map(localEntries);
		for (const [id, entry] of remoteEntries) result.set(id, entry);
		return result;
	}

	async set(mediaType, id, data, ttlMs, now) {
		// 本地先写（await），远端 fire-and-forget
		await this.local.set(mediaType, id, data, ttlMs, now);
		this.remote.set(mediaType, id, data, ttlMs, now).catch(error => warnCacheError("远端写入", error));
	}

	async setMany(entries, now) {
		// 本地先批量写（await），远端 fire-and-forget
		await this.local.setMany(entries, now);
		this.remote.setMany(entries, now).catch(error => warnCacheError("远端写入", error));
	}

	async merge(mediaType, id, partialData, ttlMs, now) {
		// 本地合并（await），远端合并 fire-and-forget
		await this.local.merge(mediaType, id, partialData, ttlMs, now);
		this.remote.merge(mediaType, id, partialData, ttlMs, now).catch(error => warnCacheError("远端写入", error));
	}

	// 判断条目是否已包含所有需要的字段（字段值非 undefined）。
	static _hasFields(entry, fields) {
		if (!entry) return false;
		return fields.every(field => entry[field] !== undefined);
	}

	// 合并本地与远端条目：本地已有字段保留，远端填充本地缺失的字段。
	static _mergeEntries(local, remote) {
		const merged = { ...remote, ...local };
		const source = local ?? remote;
		return { merged, ttlMs: source.expiresAt - source.createdAt };
	}

	async getWithFields(mediaType, id, fields, now) {
		const local = await this.local.get(mediaType, id, now);
		if (TieredCacheStore._hasFields(local, fields)) return local;
		// 本地缺失字段，查远端
		const remote = await this.remote.get(mediaType, id, now);
		if (!remote) return local;
		// 合并：本地保留，远端填充
		const { merged, ttlMs } = TieredCacheStore._mergeEntries(local, remote);
		this.local.set(mediaType, id, merged, ttlMs, now).catch(error => warnCacheError("本地回写", error));
		return merged;
	}

	async getManyWithFields(mediaType, ids, fields, now) {
		const localEntries = await this.local.getMany(mediaType, ids, now);
		// 收集本地缺失字段的 id
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
		if (writeback.length > 0) this.local.setMany(writeback, now).catch(error => warnCacheError("本地回写", error));
		return result;
	}
}

// 脚本运行时（Surge/Loon/QX）有 $done/$response 全局变量，done() 后宿主会终止脚本。
function isScriptRuntime() {
	return typeof $done !== "undefined" || typeof $response !== "undefined";
}

// 将缓存写入包装为 fire-and-forget：错误仅记录警告，并在 Workers 上通过 waitUntil 保活。
// 脚本运行时无 waitUntil 时，等待写入完成（最多 2 秒），避免宿主终止脚本导致请求丢失。
// 反代服务器（Vercel/Node.js）是长期运行的进程，不需要等待，fire-and-forget 会自然完成。
async function fireCacheWrite(promise, waitUntil) {
	if (!promise) return;
	const handled = promise.catch(error => warnCacheError("写入", error));
	if (typeof waitUntil === "function") {
		waitUntil(handled);
	} else if (isScriptRuntime()) {
		// 脚本运行时无 waitUntil，等待请求完成或超时（2 秒），确保 HTTP 请求在 done() 前发出。
		await Promise.race([handled, new Promise(resolve => setTimeout(resolve, 2000))]);
	}
}

export { BlobCacheStore, CacheStore, fireCacheWrite, RemoteCacheStore, TieredCacheStore };
