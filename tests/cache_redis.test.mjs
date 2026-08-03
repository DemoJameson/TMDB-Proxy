import assert from "node:assert/strict";
import test from "node:test";
import app from "../src/Hono.js";
import { RedisCacheStore } from "../src/tmdb/cache-redis.mjs";
import { fireCacheWrite } from "../src/tmdb/cache-store.mjs";
import { CACHE_TTL_MS, CACHE_NEGATIVE_TTL_MS } from "../src/tmdb/cache.mjs";

// 模拟 Upstash Redis 接口的内存实现，用于测试 RedisCacheStore。
// In-memory mock of the Upstash Redis interface for testing RedisCacheStore.
function createMockRedis() {
	const store = new Map();
	return {
		store,
		async get(key) {
			return store.has(key) ? store.get(key) : null;
		},
		async mget(...keys) {
			return keys.map(k => (store.has(k) ? store.get(k) : null));
		},
		async set(key, value, options) {
			store.set(key, value);
			return "OK";
		},
		pipeline() {
			const ops = [];
			return {
				set(key, value, options) {
					ops.push({ key, value });
					return this;
				},
				async exec() {
					for (const op of ops) store.set(op.key, op.value);
					return ops.map(() => "OK");
				},
			};
		},
	};
}

/***************** RedisCacheStore 单元测试 *****************/

test("RedisCacheStore.get 返回已缓存的条目", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = Date.now();
	const data = { aliases: { CN: "搏击俱乐部" }, createdAt: now, expiresAt: now + CACHE_TTL_MS };
	await redis.set("tmdb:cache:movie:550", JSON.stringify(data));

	const entry = await store.get("movie", "550");
	assert.equal(entry.aliases.CN, "搏击俱乐部");
});

test("RedisCacheStore.get 对缺失的键返回 null", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const entry = await store.get("movie", "999");
	assert.equal(entry, null);
});

test("RedisCacheStore.get 过滤无效条目", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	await redis.set("tmdb:cache:movie:550", JSON.stringify({ foo: "bar" }));
	const entry = await store.get("movie", "550");
	assert.equal(entry, null);
});

test("RedisCacheStore.getMany 使用 MGET 批量读取", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = Date.now();
	await redis.set("tmdb:cache:movie:550", JSON.stringify({ aliases: { CN: "搏击俱乐部" }, createdAt: now, expiresAt: now + CACHE_TTL_MS }));
	await redis.set("tmdb:cache:movie:551", JSON.stringify({ aliases: { CN: "十二宫" }, createdAt: now, expiresAt: now + CACHE_TTL_MS }));

	const result = await store.getMany("movie", ["550", "551", "999"]);
	assert.equal(result.size, 2);
	assert.equal(result.get("550").aliases.CN, "搏击俱乐部");
	assert.equal(result.get("551").aliases.CN, "十二宫");
	assert.equal(result.has("999"), false);
});

test("RedisCacheStore.getMany 空数组返回空 Map", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const result = await store.getMany("movie", []);
	assert.equal(result.size, 0);
});

test("RedisCacheStore.set 写入正确的键格式和 TTL", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = 1_700_000_000_000;
	const data = { aliases: { CN: "搏击俱乐部" } };
	await store.set("movie", "550", data, CACHE_TTL_MS, now);

	assert.ok(redis.store.has("tmdb:cache:movie:550"));
	const stored = JSON.parse(redis.store.get("tmdb:cache:movie:550"));
	assert.equal(stored.aliases.CN, "搏击俱乐部");
	assert.equal(stored.createdAt, now);
	assert.equal(stored.expiresAt, now + CACHE_TTL_MS);
});

test("RedisCacheStore.setMany 使用 pipeline 批量写入", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = 1_700_000_000_000;
	const entries = [
		{ mediaType: "movie", id: "550", data: { aliases: { CN: "搏击俱乐部" } }, ttlMs: CACHE_TTL_MS },
		{ mediaType: "tv", id: "1399", data: { aliases: { TW: "權力的遊戲" } }, ttlMs: CACHE_TTL_MS },
	];
	await store.setMany(entries, now);

	assert.ok(redis.store.has("tmdb:cache:movie:550"));
	assert.ok(redis.store.has("tmdb:cache:tv:1399"));
	const movieEntry = JSON.parse(redis.store.get("tmdb:cache:movie:550"));
	assert.equal(movieEntry.aliases.CN, "搏击俱乐部");
	assert.equal(movieEntry.expiresAt, now + CACHE_TTL_MS);
	const tvEntry = JSON.parse(redis.store.get("tmdb:cache:tv:1399"));
	assert.equal(tvEntry.aliases.TW, "權力的遊戲");
});

test("RedisCacheStore.setMany 空数组不执行 pipeline", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	await store.setMany([]);
	assert.equal(redis.store.size, 0);
});

test("RedisCacheStore.merge 合并部分数据并保留原 createdAt", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = 1_700_000_000_000;
	const existing = { aliases: { CN: "搏击俱乐部" }, createdAt: 123, expiresAt: 123 + CACHE_TTL_MS };
	await redis.set("tmdb:cache:movie:550", JSON.stringify(existing));

	await store.merge("movie", "550", { imdbId: "tt0137523" }, CACHE_TTL_MS, now);

	const merged = JSON.parse(redis.store.get("tmdb:cache:movie:550"));
	assert.equal(merged.aliases.CN, "搏击俱乐部");
	assert.equal(merged.imdbId, "tt0137523");
	assert.equal(merged.createdAt, 123);
	assert.equal(merged.expiresAt, now + CACHE_TTL_MS);
});

test("RedisCacheStore.merge 对不存在的键创建新条目", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	const now = 1_700_000_000_000;

	await store.merge("movie", "550", { aliases: { CN: "搏击俱乐部" } }, CACHE_TTL_MS, now);

	const merged = JSON.parse(redis.store.get("tmdb:cache:movie:550"));
	assert.equal(merged.aliases.CN, "搏击俱乐部");
	assert.equal(merged.createdAt, now);
	assert.equal(merged.expiresAt, now + CACHE_TTL_MS);
});

test("RedisCacheStore 键格式不包含 dj 前缀", async () => {
	const redis = createMockRedis();
	const store = new RedisCacheStore(redis);
	await store.set("tv", "1399", { aliases: {} }, CACHE_NEGATIVE_TTL_MS);

	const keys = Array.from(redis.store.keys());
	assert.equal(keys[0], "tmdb:cache:tv:1399");
	assert.ok(!keys[0].includes("dj"));
});

/***************** fireCacheWrite 单元测试 *****************/

test("fireCacheWrite 在提供 waitUntil 时调用它", async () => {
	let called = false;
	const waitUntil = promise => {
		called = true;
		promise.catch(() => {});
	};
	const resolvingPromise = Promise.resolve("ok");
	fireCacheWrite(resolvingPromise, waitUntil);
	assert.equal(called, true);
});

test("fireCacheWrite 吞掉写入错误", async () => {
	let errored = false;
	const waitUntil = () => { errored = true; };
	const rejectingPromise = Promise.reject(new Error("write failed"));
	fireCacheWrite(rejectingPromise, waitUntil);
	// 等待微任务队列清空，不应抛出未处理 rejection
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(errored, true);
});

test("fireCacheWrite 对 undefined promise 不做任何操作", () => {
	let called = false;
	const waitUntil = () => { called = true; };
	fireCacheWrite(undefined, waitUntil);
	assert.equal(called, false);
});

test("fireCacheWrite 无 waitUntil 时仍吞掉错误", async () => {
	const rejectingPromise = Promise.reject(new Error("write failed"));
	fireCacheWrite(rejectingPromise, undefined);
	await new Promise(resolve => setTimeout(resolve, 10));
	// 不应抛出未处理 rejection
});

/***************** /cache 端点测试（Redis 未配置） *****************/

test("/cache/get 未配置 Redis 时返回空结果", async () => {
	const response = await app.request("https://example.test/cache/get", {
		method: "POST",
		body: JSON.stringify({ movie: [550], tv: [1399] }),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { movie: {}, tv: {} });
});

test("/cache/set 未配置 Redis 时返回 503", async () => {
	const response = await app.request("https://example.test/cache/set", {
		method: "POST",
		body: JSON.stringify([{ mediaType: "movie", id: "550", data: { aliases: { CN: "搏击俱乐部" } }, ttlMs: CACHE_TTL_MS }]),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 503);
	const body = await response.json();
	assert.equal(body.ok, false);
	assert.equal(body.error, "Redis not configured");
});

test("/api/cache/get (Vercel 路径) 与 /cache/get 行为一致", async () => {
	const response = await app.request("https://example.test/api/cache/get", {
		method: "POST",
		body: JSON.stringify({ movie: [550], tv: [1399] }),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { movie: {}, tv: {} });
});

test("/api/cache/set (Vercel 路径) 与 /cache/set 行为一致", async () => {
	const response = await app.request("https://example.test/api/cache/set", {
		method: "POST",
		body: JSON.stringify([{ mediaType: "movie", id: "550", data: { aliases: {} }, ttlMs: CACHE_NEGATIVE_TTL_MS }]),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 503);
	const body = await response.json();
	assert.equal(body.ok, false);
});

test("/cache/get 空查询返回空结果", async () => {
	const response = await app.request("https://example.test/cache/get", {
		method: "POST",
		body: JSON.stringify({}),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body, { movie: {}, tv: {} });
});

test("/cache/set 空数组在 Redis 未配置时仍返回 503", async () => {
	const response = await app.request("https://example.test/cache/set", {
		method: "POST",
		body: JSON.stringify([]),
		headers: { "content-type": "application/json" },
	});
	assert.equal(response.status, 503);
});

test("GET /cache/get 返回 404（仅支持 POST）", async () => {
	const response = await app.request("https://example.test/cache/get", { method: "GET" });
	assert.equal(response.status, 404);
});
