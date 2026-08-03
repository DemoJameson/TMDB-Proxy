import { CacheStore } from "./cache-store.mjs";
import { isValidEntry } from "./cache.mjs";

// 按条目拆分键存储的 Redis 缓存实现，使用 MGET / pipeline 批量优化。
// Per-entry Redis cache store with MGET / pipeline batch optimization.
class RedisCacheStore extends CacheStore {
	constructor(redis) {
		super();
		this.redis = redis;
	}
	buildKey(mediaType, id) {
		return `tmdb:cache:${mediaType}:${id}`;
	}
	async get(mediaType, id) {
		const raw = await this.redis.get(this.buildKey(mediaType, id));
		if (!raw) return null;
		const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
		return isValidEntry(entry) ? entry : null;
	}
	async getMany(mediaType, ids) {
		if (ids.length === 0) return new Map();
		const keys = ids.map(id => this.buildKey(mediaType, id));
		const values = await this.redis.mget(...keys);
		const result = new Map();
		for (let i = 0; i < ids.length; i++) {
			if (!values[i]) continue;
			const entry = typeof values[i] === "string" ? JSON.parse(values[i]) : values[i];
			if (isValidEntry(entry)) result.set(String(ids[i]), entry);
		}
		return result;
	}
	async set(mediaType, id, data, ttlMs, now) {
		const timestamp = now ?? Date.now();
		const entry = { ...data, createdAt: data.createdAt ?? timestamp, expiresAt: timestamp + ttlMs };
		await this.redis.set(this.buildKey(mediaType, id), JSON.stringify(entry), {
			ex: Math.floor(ttlMs / 1000),
		});
	}
	async setMany(entries, now) {
		if (entries.length === 0) return;
		const pipeline = this.redis.pipeline();
		const timestamp = now ?? Date.now();
		for (const { mediaType, id, data, ttlMs } of entries) {
			const entry = { ...data, createdAt: data.createdAt ?? timestamp, expiresAt: timestamp + ttlMs };
			pipeline.set(this.buildKey(mediaType, id), JSON.stringify(entry), {
				ex: Math.floor(ttlMs / 1000),
			});
		}
		await pipeline.exec();
	}
	async merge(mediaType, id, partialData, ttlMs, now) {
		const existing = await this.get(mediaType, id);
		const timestamp = now ?? Date.now();
		const entry = {
			...(existing ?? {}),
			...partialData,
			createdAt: existing?.createdAt ?? timestamp,
			expiresAt: timestamp + ttlMs,
		};
		await this.redis.set(this.buildKey(mediaType, id), JSON.stringify(entry), {
			ex: Math.floor(ttlMs / 1000),
		});
	}
}

export { RedisCacheStore };
