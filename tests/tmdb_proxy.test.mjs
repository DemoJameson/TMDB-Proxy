import assert from "node:assert/strict";
import test from "node:test";
import app from "../src/Hono.js";
import { pickChineseAlias } from "../src/tmdb/aliases.mjs";
import { CACHE_MAX_BYTES, CACHE_NEGATIVE_TTL_MS, CACHE_FULL_TTL_MS, CACHE_TTL_MS, createEmptyCache, normalizeCache, setCacheEntry, writeCache } from "../src/tmdb/cache.mjs";
import { parseRuntimeArgument, resolveProxyConfig } from "../src/tmdb/config.mjs";
import { applyTmdbRequestRules, applyTmdbResponseRules, DEFAULT_TMDB_API_KEY, fetchTmdbWithNativeFetch, STATE_HEADER } from "../src/tmdb/proxy.mjs";
import { isForwardHost, isTmdbHost, isTmdbImageHost } from "../src/tmdb/routes.mjs";

// 拦截缓存后端 HTTP 请求，返回空结果，避免测试中真实网络调用。
// Intercepts cache backend HTTP requests, returns empty results to avoid real network calls in tests.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (resource, init) => {
	const url = typeof resource === "string" ? resource : resource?.url ?? "";
	if (url.includes("/cache/get")) return new Response(JSON.stringify({ movie: {}, tv: {} }), { status: 200, headers: { "content-type": "application/json" } });
	if (url.includes("/cache/set")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	return originalFetch(resource, init);
};

function createMemoryStorage(initial = {}) {
	return {
		store: { ...initial },
		getItem(key, defaultValue) {
			return this.store[key] ?? defaultValue;
		},
		setItem(key, value) {
			this.store[key] = value;
			return true;
		},
	};
}

test("请求电影中文详情时追加 alternative_titles 并记录客户端是否已请求", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN", headers: {} };
	const { $request } = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const url = new URL($request.url);
	assert.equal(url.searchParams.get("api_key"), DEFAULT_TMDB_API_KEY);
	assert.equal(url.searchParams.get("append_to_response"), "alternative_titles,external_ids");
	assert.ok($request.headers[STATE_HEADER]);
});

test("已有 api_key 时不会覆盖客户端参数", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?api_key=client-key&language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.equal(new URL(request.url).searchParams.get("api_key"), "client-key");
});

test("vidora TMDB 域名参与代理规则", async () => {
	assert.equal(isTmdbHost("vidora-tmdb.wwmm.date"), true);
	const request = { method: "GET", url: "https://vidora-tmdb.wwmm.date/3/movie/634649?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const url = new URL(request.url);
	assert.equal(url.searchParams.get("append_to_response"), "alternative_titles,external_ids");
});

test("开启 imageWebp 时为 TMDB 图片请求注入 Accept: image/webp", async () => {
	assert.equal(isTmdbImageHost("image.tmdb.org"), true);
	const request = { method: "GET", url: "https://image.tmdb.org/t/p/original/ySVFNbEAOWJgo5TVYk6MeIfTU34.jpg", headers: {} };
	await applyTmdbRequestRules(request, { argument: { imageWebp: true } });
	assert.equal(request.headers.Accept, "image/webp,*/*");
	assert.equal(request.url, "https://image.tmdb.org/t/p/original/ySVFNbEAOWJgo5TVYk6MeIfTU34.jpg");
});

test("关闭 imageWebp 时不注入 Accept 头", async () => {
	const request = { method: "GET", url: "https://image.tmdb.org/t/p/original/ySVFNbEAOWJgo5TVYk6MeIfTU34.jpg", headers: {} };
	await applyTmdbRequestRules(request, { argument: { imageWebp: false } });
	assert.equal(request.headers.Accept, undefined);
});

test("默认开启 imageWebp 时图片请求注入 Accept 头", async () => {
	const request = { method: "GET", url: "https://image.tmdb.org/t/p/w500/abc.jpg", headers: {} };
	await applyTmdbRequestRules(request, { argument: {} });
	assert.equal(request.headers.Accept, "image/webp,*/*");
});

test("图片请求已有小写 accept 头时覆盖而非新增重复头", async () => {
	const request = { method: "GET", url: "https://image.tmdb.org/t/p/w500/abc.jpg", headers: { accept: "*/*" } };
	await applyTmdbRequestRules(request, { argument: { imageWebp: true } });
	const acceptKeys = Object.keys(request.headers).filter(key => key.toLowerCase() === "accept");
	assert.equal(acceptKeys.length, 1);
	assert.equal(request.headers.Accept, "image/webp,*/*");
	assert.equal(request.headers.accept, undefined);
});

test("追加 alternative_titles 时保留详情请求已有的查询参数", async () => {
	const request = {
		method: "GET",
		url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits%2Cimages&api_key=client-key&page=2",
		headers: {},
	};
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const url = new URL(request.url);
	assert.equal(url.searchParams.get("language"), "zh-CN");
	assert.equal(url.searchParams.get("api_key"), "client-key");
	assert.equal(url.searchParams.get("page"), "2");
	assert.equal(url.searchParams.get("append_to_response"), "credits,images,alternative_titles,external_ids");
});

test("客户端已请求 alternative_titles 时响应保留该字段", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=alternative_titles", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Fight Club", overview: "English", alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aliasFallback: true } });
	const body = JSON.parse(response.body);
	assert.equal(body.title, "搏击俱乐部");
	assert.ok(body.alternative_titles);
});

test("代理自动追加 alternative_titles 时响应移除该字段", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399?language=zh-HK", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json", "content-length": "99" },
		body: JSON.stringify({ name: "Game of Thrones", overview: "English", alternative_titles: { results: [{ iso_3166_1: "CN", title: "权力的游戏" }] } }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aliasFallback: true } });
	const body = JSON.parse(response.body);
	assert.equal(body.name, "權力的遊戲");
	assert.equal(body.overview, "English");
	assert.equal(Object.hasOwn(body, "alternative_titles"), false);
	assert.equal(response.headers["content-length"], undefined);
});

test("详情响应有中文别名时写入别名缓存供列表复用", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=alternative_titles", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Fight Club", alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }, { iso_3166_1: "TW", title: "鬥陣俱樂部" }] } }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aliasFallback: true }, storage });
	const cache = storage.store.dj_tmdb_proxy_cache;
	assert.deepEqual(cache.stores.movie["550"].aliases, { CN: "搏击俱乐部", TW: "鬥陣俱樂部" });
});

test("详情响应无中文别名但有详情字段时写入正常缓存", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=alternative_titles", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title: "Fight Club", alternative_titles: { titles: [{ iso_3166_1: "US", title: "Fight Club" }] } }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aliasFallback: true }, storage, now });
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.deepEqual(entry.aliases, {});
	assert.equal(entry.title, "Fight Club");
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_TTL_MS);
});

test("中文 collection 详情追加 translations 并回填中文名称", async () => {
	const request = { method: "GET", url: "https://api.tmdb.org/3/collection/531241?api_key=client-key&language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const requestUrl = new URL(request.url);
	assert.equal(requestUrl.searchParams.get("api_key"), "client-key");
	assert.equal(requestUrl.searchParams.get("language"), "zh-CN");
	assert.equal(requestUrl.searchParams.get("append_to_response"), "translations");

	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "The Collection", translations: [{ iso_3166_1: "CN", data: { title: "中文合集" } }] }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aliasFallback: true } });
	const body = JSON.parse(response.body);
	assert.equal(body.name, "中文合集");
	assert.equal(Object.hasOwn(body, "translations"), false);
});

test("英文 collection 详情不追加 translations", async () => {
	const request = { method: "GET", url: "https://api.tmdb.org/3/collection/531241?language=en-US", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.equal(new URL(request.url).searchParams.has("append_to_response"), false);
});

test("collection parts 中的电影也会补全中文片名", async () => {
	const request = {
		method: "GET",
		url: "https://api.tmdb.org/3/collection/531241?api_key=client-key&language=zh-CN&append_to_response=translations",
		headers: {},
	};
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Spider-Man Collection",
			translations: [],
			parts: [{ id: 634649, title: "Spider-Man: No Way Home" }],
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async aliasRequest => {
			fetched.push(aliasRequest.url);
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "蜘蛛侠：英雄无归" }] } }) };
		},
	});
	assert.deepEqual(fetched, ["https://api.tmdb.org/3/movie/634649?api_key=client-key&language=zh-CN&append_to_response=alternative_titles%2Cexternal_ids"]);
	assert.equal(JSON.parse(response.body).parts[0].title, "蜘蛛侠：英雄无归");
});

test("中文别名按语言地区优先级选择并转换", () => {
	const titles = [
		{ iso_3166_1: "TW", title: "鬥陣俱樂部" },
		{ iso_3166_1: "CN", title: "搏击俱乐部" },
	];
	assert.equal(pickChineseAlias(titles, "zh-TW"), "鬥陣俱樂部");
	assert.equal(pickChineseAlias(titles, "zh-CN"), "搏击俱乐部");
});

test("aggregateCredits 优先改写剧集与季 credits", async () => {
	const series = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(series, { argument: { aggregateCredits: true } });
	assert.equal(new URL(series.url).pathname, "/3/tv/1399/aggregate_credits");

	const season = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/season/1/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(season, { argument: { aggregateCredits: true } });
	assert.equal(new URL(season.url).pathname, "/3/tv/1399/season/1/aggregate_credits");
});

test("TV append_to_response 中的 credits 改为 aggregate_credits 并兼容响应字段", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399?language=zh-CN&append_to_response=credits,images", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true, aliasFallback: false } });
	const url = new URL(request.url);
	assert.equal(url.searchParams.get("append_to_response"), "aggregate_credits,images,alternative_titles,external_ids");
	assert.ok(request.headers[STATE_HEADER]);

	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Game of Thrones",
			aggregate_credits: { cast: [{ id: 1, name: "Actor", roles: [{ character: "Hero" }] }] },
			images: { backdrops: [] },
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true, aliasFallback: false } });
	const body = JSON.parse(response.body);
	assert.deepEqual(body.credits.cast, [{ id: 1, name: "Actor", character: "Hero" }]);
	assert.equal(Object.hasOwn(body, "aggregate_credits"), false);
	assert.deepEqual(body.images, { backdrops: [] });
});

test("TV append_to_response 已包含 aggregate_credits 时保留原字段", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399?append_to_response=credits,aggregate_credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	assert.equal(new URL(request.url).searchParams.get("append_to_response"), "aggregate_credits");

	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ aggregate_credits: { cast: [{ id: 1, roles: [{ character: "Hero" }] }] } }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	assert.deepEqual(body.credits.cast, [{ id: 1, character: "Hero" }]);
	assert.ok(body.aggregate_credits);
});

test("关闭 aggregateCredits 时不改写 TV append_to_response credits", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399?append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: false } });
	assert.equal(new URL(request.url).searchParams.get("append_to_response"), "credits");
});

test("自动改写的 aggregate_credits 响应兼容普通 credits 字段", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			cast: [
				{
					id: 1,
					name: "Actor",
					roles: [
						{ character: "Hero", episode_count: 3 },
						{ character: "Villain", episode_count: 1 },
					],
					total_episode_count: 4,
				},
			],
			crew: [
				{
					id: 2,
					name: "Writer",
					jobs: [{ job: "Writer", episode_count: 4 }],
					total_episode_count: 4,
				},
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	assert.deepEqual(body.cast, [{ id: 1, name: "Actor", character: "Hero / Villain" }]);
	assert.deepEqual(body.crew, [{ id: 2, name: "Writer", job: "Writer" }]);
});

test("aggregate_credits 导演超过 3 个时按集数保留前 3", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			crew: [
				{ id: 10, name: "导演A", profile_path: "/a.jpg", jobs: [{ job: "Director", episode_count: 2 }], total_episode_count: 2 },
				{ id: 11, name: "导演B", profile_path: "/b.jpg", jobs: [{ job: "Director", episode_count: 8 }], total_episode_count: 8 },
				{ id: 12, name: "导演C", profile_path: "/c.jpg", jobs: [{ job: "Director", episode_count: 5 }], total_episode_count: 5 },
				{ id: 13, name: "导演D", profile_path: "/d.jpg", jobs: [{ job: "Director", episode_count: 1 }], total_episode_count: 1 },
				{ id: 14, name: "导演E", profile_path: "/e.jpg", jobs: [{ job: "Director", episode_count: 3 }], total_episode_count: 3 },
				{ id: 15, name: "编剧X", profile_path: "/x.jpg", jobs: [{ job: "Writer", episode_count: 10 }], total_episode_count: 10 },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	const directorNames = body.crew.filter(c => c.job === "Director").map(c => c.name);
	const writerNames = body.crew.filter(c => c.job === "Writer").map(c => c.name);
	assert.equal(directorNames.length, 2);
	assert.deepEqual(directorNames, ["导演B", "导演C"]);
	assert.deepEqual(writerNames, ["编剧X"]);
});

test("aggregate_credits 导演不超过 2 个时全部保留", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			crew: [
				{ id: 10, name: "导演A", profile_path: "/a.jpg", jobs: [{ job: "Director", episode_count: 2 }], total_episode_count: 2 },
				{ id: 11, name: "导演B", profile_path: "/b.jpg", jobs: [{ job: "Director", episode_count: 8 }], total_episode_count: 8 },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	const directorNames = body.crew.filter(c => c.job === "Director").map(c => c.name);
	assert.deepEqual(directorNames, ["导演A", "导演B"]);
});

test("aggregate_credits 前 2 导演过滤掉无头像的，至少保留一个", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			crew: [
				{ id: 10, name: "导演A", profile_path: null, jobs: [{ job: "Director", episode_count: 9 }], total_episode_count: 9 },
				{ id: 11, name: "导演B", profile_path: "/b.jpg", jobs: [{ job: "Director", episode_count: 8 }], total_episode_count: 8 },
				{ id: 12, name: "导演C", profile_path: null, jobs: [{ job: "Director", episode_count: 5 }], total_episode_count: 5 },
				{ id: 13, name: "导演D", profile_path: "/d.jpg", jobs: [{ job: "Director", episode_count: 4 }], total_episode_count: 4 },
				{ id: 14, name: "导演E", profile_path: "/e.jpg", jobs: [{ job: "Director", episode_count: 3 }], total_episode_count: 3 },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	const directors = body.crew.filter(c => c.job === "Director");
	// 前 2 为 A(9,无头像)、B(8,有头像)，过滤后仅保留 B
	// Top 2 are A(9,no photo), B(8,photo); after filtering only B remains
	assert.deepEqual(directors.map(c => c.name), ["导演B"]);
});

test("aggregate_credits 前 2 导演全无头像时回退保留集数最多的", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			crew: [
				{ id: 10, name: "导演A", profile_path: null, jobs: [{ job: "Director", episode_count: 9 }], total_episode_count: 9 },
				{ id: 11, name: "导演B", profile_path: null, jobs: [{ job: "Director", episode_count: 8 }], total_episode_count: 8 },
				{ id: 12, name: "导演C", profile_path: null, jobs: [{ job: "Director", episode_count: 5 }], total_episode_count: 5 },
				{ id: 13, name: "导演D", profile_path: "/d.jpg", jobs: [{ job: "Director", episode_count: 4 }], total_episode_count: 4 },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	const directors = body.crew.filter(c => c.job === "Director");
	// 前 2 全无头像，回退保留集数最多的导演A
	// Top 2 all lack photos, fall back to director A with most episodes
	assert.deepEqual(directors.map(c => c.name), ["导演A"]);
});

test("aggregate_credits 同一人员多职位时展开为独立条目", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			crew: [
				{
					id: 20,
					name: "导演兼编剧",
					department: "Directing",
					jobs: [
						{ credit_id: "c1", job: "Director", episode_count: 5 },
						{ credit_id: "c2", job: "Co-Director", episode_count: 2 },
						{ credit_id: "c3", job: "Writer", episode_count: 3 },
					],
					total_episode_count: 10,
				},
				{ id: 21, name: "编剧B", department: "Writing", jobs: [{ credit_id: "c4", job: "Writer", episode_count: 8 }], total_episode_count: 8 },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	const body = JSON.parse(response.body);
	const directors = body.crew.filter(c => c.job === "Director");
	const coDirectors = body.crew.filter(c => c.job === "Co-Director");
	const writers = body.crew.filter(c => c.job === "Writer");
	assert.equal(directors.length, 1);
	assert.equal(directors[0].name, "导演兼编剧");
	assert.equal(directors[0].credit_id, "c1");
	assert.equal(coDirectors.length, 1);
	assert.equal(coDirectors[0].credit_id, "c2");
	assert.equal(writers.length, 2);
	assert.deepEqual(writers.map(c => c.name), ["导演兼编剧", "编剧B"]);
});

test("用户直接请求 aggregate_credits 时不改写其响应结构", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/aggregate_credits", headers: {} };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, roles: [{ character: "Hero" }] }] }),
	};
	await applyTmdbResponseRules(request, response, { argument: { aggregateCredits: true } });
	assert.deepEqual(JSON.parse(response.body), { cast: [{ id: 1, roles: [{ character: "Hero" }] }] });
});

test("关闭 aggregateCredits 时保持原始 credits", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399/credits?language=zh-CN", headers: {} };
	let fetchCount = 0;
	await applyTmdbRequestRules(request, {
		argument: { aggregateCredits: false },
		fetcher: async () => {
			fetchCount += 1;
			return { ok: true, status: 200, body: "{}" };
		},
	});
	assert.equal(new URL(request.url).pathname, "/3/tv/1399/credits");
	assert.equal(fetchCount, 0);
});

test("配置解析支持对象、逗号串和查询覆盖", () => {
	assert.deepEqual(parseRuntimeArgument("false,true"), { aliasFallback: "false", characterTranslation: "true", aggregateCredits: undefined, imageWebp: undefined, cacheBackend: undefined });
	assert.deepEqual(parseRuntimeArgument({ "false,true": "" }), { aliasFallback: "false", characterTranslation: "true", aggregateCredits: undefined, imageWebp: undefined, cacheBackend: undefined });
	const url = new URL("https://api.themoviedb.org/3/movie/1?proxy.aggregateCredits=0&language=zh-CN");
	const config = resolveProxyConfig({ argument: { aggregateCredits: true }, env: {}, url });
	assert.equal(config.aggregateCredits, false);
	assert.equal(url.searchParams.has("proxy.aggregateCredits"), false);
});

test("返回 results 的电影列表也会按条目补全中文片名", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: { Authorization: "Bearer token", [STATE_HEADER]: "internal" } };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			results: [
				{ id: 550, title: "Fight Club" },
				{ id: 11, title: "星球大战" },
			],
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async aliasRequest => {
			fetched.push(aliasRequest);
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) };
		},
	});
	assert.equal(fetched.length, 1);
	assert.equal(fetched[0].url, "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=alternative_titles%2Cexternal_ids");
	assert.equal(fetched[0].headers.Authorization, "Bearer token");
	assert.equal(fetched[0].headers[STATE_HEADER], undefined);
	assert.deepEqual(
		JSON.parse(response.body).results.map(item => item.title),
		["搏击俱乐部", "星球大战"],
	);
});

test("混合搜索列表会按 media_type 分别补全 movie title 和 tv name", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/search/multi?language=zh-TW&query=test", headers: {} };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			results: [
				{ id: 550, media_type: "movie", title: "Fight Club" },
				{ id: 1399, media_type: "tv", name: "Game of Thrones" },
			],
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async aliasRequest => {
			const url = new URL(aliasRequest.url);
			if (url.pathname.includes("/movie/")) return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) };
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { results: [{ iso_3166_1: "CN", title: "权力的游戏" }] } }) };
		},
	});
	const body = JSON.parse(response.body);
	assert.equal(body.results[0].title, "搏擊俱樂部");
	assert.equal(body.results[1].name, "權力的遊戲");
});

test("混合搜索中的 person 条目不会按 tv name 误补全", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/search/multi?language=zh-CN&query=test", headers: {} };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			results: [
				{ id: 287, media_type: "person", name: "Brad Pitt" },
				{ id: 1399, media_type: "tv", name: "Game of Thrones" },
			],
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async aliasRequest => {
			fetched.push(aliasRequest.url);
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { results: [{ iso_3166_1: "CN", title: "权力的游戏" }] } }) };
		},
	});
	const body = JSON.parse(response.body);
	assert.equal(body.results[0].name, "Brad Pitt");
	assert.equal(body.results[1].name, "权力的游戏");
	assert.deepEqual(fetched, ["https://api.themoviedb.org/3/tv/1399?language=zh-CN&query=test&append_to_response=alternative_titles%2Cexternal_ids"]);
});

test("非中文列表请求不会为条目额外请求别名", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=en-US", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async () => {
			fetchCount += 1;
			return { ok: true, status: 200, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).results[0].title, "Fight Club");
});

test("列表中文补全默认允许 10 个别名请求并发", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: {} };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ results: Array.from({ length: 10 }, (_item, index) => ({ id: index + 1, title: `Movie ${index + 1}` })) }),
	};
	let active = 0;
	let maxActive = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise(resolve => setTimeout(resolve, 1));
			active -= 1;
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "中文片名" }] } }) };
		},
	});
	assert.equal(maxActive, 10);
});

test("列表别名缓存按 movie/tv 分层并保存四个区域", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-TW", headers: {} };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		fetcher: async () => ({
			ok: true,
			status: 200,
			body: JSON.stringify({
				alternative_titles: {
					titles: [
						{ iso_3166_1: "CN", title: "搏击俱乐部" },
						{ iso_3166_1: "SG", title: "搏击俱乐部" },
						{ iso_3166_1: "TW", title: "鬥陣俱樂部" },
						{ iso_3166_1: "HK", title: "搏擊會" },
					],
				},
			}),
		}),
	});
	const cache = storage.store.dj_tmdb_proxy_cache;
	assert.equal(JSON.parse(response.body).results[0].title, "鬥陣俱樂部");
	assert.deepEqual(cache.stores.movie["550"].aliases, { CN: "搏击俱乐部", SG: "搏击俱乐部", TW: "鬥陣俱樂部", HK: "搏擊會" });
	assert.equal(cache.stores.tv["550"], undefined);
});

test("TV 别名缓存写入 stores.tv 且不覆盖同 ID movie", async () => {
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: { movie: { 1399: { aliases: { CN: "电影名" }, createdAt: 1, expiresAt: 9_999_999_999_999 } }, tv: {} },
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/popular?language=zh-HK", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 1399, name: "Game of Thrones" }] }) };
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		fetcher: async () => ({ ok: true, status: 200, body: JSON.stringify({ alternative_titles: { results: [{ iso_3166_1: "TW", title: "權力的遊戲" }] } }) }),
	});
	const cache = storage.store.dj_tmdb_proxy_cache;
	assert.equal(cache.stores.movie["1399"].aliases.CN, "电影名");
	assert.equal(cache.stores.tv["1399"].aliases.TW, "權力的遊戲");
	assert.equal(JSON.parse(response.body).results[0].name, "權力的遊戲");
});

test("列表别名缓存命中时按语言选择区域且不请求 TMDB", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: { 550: { aliases: { CN: "搏击俱乐部", TW: "鬥陣俱樂部" }, createdAt: now, expiresAt: now + CACHE_TTL_MS } },
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-TW", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		now,
		fetcher: async () => {
			fetchCount += 1;
			return { ok: false, status: 500, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).results[0].title, "鬥陣俱樂部");
});

test("缓存版本无效、过期和大小上限会被正确处理", () => {
	const invalid = normalizeCache({ version: 99, stores: { movie: { 1: {} } } });
	assert.deepEqual(invalid, createEmptyCache());
	const cache = createEmptyCache();
	const bigAlias = "a".repeat(200 * 1024);
	for (let index = 0; index < 3; index += 1) setCacheEntry(cache, "movie", index + 1, { CN: bigAlias }, index + 1);
	const storage = { setItem: (_key, value) => value };
	writeCache(storage, cache, 3);
	assert.equal(cache.stores.movie["1"], undefined);
	assert.ok(cache.stores.movie["3"]);
});

test("过期缓存会重新请求并保留原 createdAt", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: { movie: { 550: { aliases: { CN: "旧片名" }, createdAt: 123, expiresAt: now - 1 } }, tv: {} },
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		now,
		fetcher: async () => ({ ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) }),
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.equal(entry.aliases.CN, "搏击俱乐部");
	assert.equal(entry.createdAt, 123);
	assert.equal(entry.expiresAt, now + CACHE_TTL_MS);
});

test("非中文或请求失败时不写缓存", async () => {
	for (const [language, aliasResponse] of [
		["en-US", { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) }],
		["zh-CN", { ok: false, status: 500, body: "{}" }],
	]) {
		const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
		const request = { method: "GET", url: `https://api.themoviedb.org/3/movie/popular?language=${language}`, headers: {} };
		const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
		await applyTmdbResponseRules(request, response, {
			argument: { aliasFallback: true },
			storage,
			fetcher: async () => aliasResponse,
		});
		assert.deepEqual(storage.store.dj_tmdb_proxy_cache, createEmptyCache());
	}
});

test("列表请求成功但无中文别名时写负缓存", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		now,
		fetcher: async () => ({ ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "US", title: "Fight Club" }] } }) }),
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.deepEqual(entry.aliases, {});
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_NEGATIVE_TTL_MS);
});

test("负缓存命中时列表不重复请求", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: { movie: { 550: { aliases: {}, createdAt: now, expiresAt: now + CACHE_NEGATIVE_TTL_MS } }, tv: {} },
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		now,
		fetcher: async () => {
			fetchCount += 1;
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).results[0].title, "Fight Club");
});

test("负缓存过期后重新请求", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: { movie: { 550: { aliases: {}, createdAt: 123, expiresAt: now - 1 } }, tv: {} },
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/popular?language=zh-CN", headers: {} };
	const response = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ results: [{ id: 550, title: "Fight Club" }] }) };
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		storage,
		now,
		fetcher: async () => {
			fetchCount += 1;
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.equal(fetchCount, 1);
	assert.equal(entry.aliases.CN, "搏击俱乐部");
	assert.equal(entry.createdAt, 123);
	assert.equal(entry.expiresAt, now + CACHE_TTL_MS);
});

test("Hono 将 Vercel API 路径映射到 TMDB，并保留代理处理结果", async () => {
	const originalFetch = globalThis.fetch;
	let upstreamRequest;
	globalThis.fetch = async (url, init) => {
		const urlStr = String(url);
		if (urlStr.includes("/cache/get")) return new Response(JSON.stringify({ movie: {}, tv: {} }), { status: 200, headers: { "content-type": "application/json" } });
		if (urlStr.includes("/cache/set")) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		upstreamRequest = { url: urlStr, init };
		return new Response(JSON.stringify({ title: "Fight Club", alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	try {
		const response = await app.request("https://example.test/api/3/movie/550?language=zh-CN", { headers: { Authorization: "Bearer client-token" } });
		assert.equal(upstreamRequest.url, `https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=alternative_titles%2Cexternal_ids`);
		assert.equal(upstreamRequest.init.headers.authorization, "Bearer client-token");
		assert.equal(upstreamRequest.init.headers[STATE_HEADER], undefined);
		assert.deepEqual(await response.json(), { title: "搏击俱乐部" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("非 TMDB 的 Vercel API 路径不会递归转发到自身", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalled = false;
	globalThis.fetch = async () => {
		fetchCalled = true;
		throw new Error("should not fetch upstream");
	};
	try {
		const response = await app.request("https://example.test/api/not-tmdb");
		assert.equal(response.status, 404);
		assert.equal(await response.text(), "Not Found");
		assert.equal(fetchCalled, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});


test("原生 fetch 预取适配器不依赖 @nsnanocat/util 的 require 分支", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		assert.equal(String(url), "https://api.themoviedb.org/3/tv/1399");
		assert.equal(init.headers.Authorization, "Bearer token");
		return new Response(JSON.stringify({ last_episode_to_air: { season_number: 8 } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	try {
		const response = await fetchTmdbWithNativeFetch({ method: "GET", url: "https://api.themoviedb.org/3/tv/1399", headers: { Authorization: "Bearer token" } });
		assert.equal(response.ok, true);
		assert.equal(JSON.parse(response.body).last_episode_to_air.season_number, 8);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("isForwardHost 识别 forwardinfo 域名", () => {
	assert.equal(isForwardHost("forwardinfo.vvebo.vip"), true);
	assert.equal(isForwardHost("api.tmdb.org"), false);
});

test("Forward TV season credits 请求（aggregateCredits 开启）重定向到 TMDB", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/tv/272432/season/1/credits?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	assert.ok(result.$response, "should return redirect response");
	assert.equal(result.$response.status, 302);
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.hostname, "api.tmdb.org");
	assert.equal(location.pathname, "/3/tv/272432/season/1/credits");
	assert.equal(location.searchParams.get("language"), "zh-CN");
	assert.equal(location.searchParams.get("api_key"), DEFAULT_TMDB_API_KEY);
});

test("Forward 中文详情请求（aliasFallback 开启）重定向到 TMDB", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.ok(result.$response);
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.pathname, "/3/movie/550");
});

test("Forward 英文详情请求不重定向（无需修改）", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=en-US", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true, aggregateCredits: true } });
	assert.equal(result.$response, undefined);
	assert.equal(request.url, "https://forwardinfo.vvebo.vip/movie/550?language=en-US");
});

test("Forward credits 请求 aggregateCredits 关闭且 aliasFallback 关闭时不重定向", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/tv/272432/credits?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aggregateCredits: false, aliasFallback: false } });
	assert.equal(result.$response, undefined);
});

test("Forward 重定向 URL 保留已有 api_key 不覆盖", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=zh-CN&api_key=custom-key", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.searchParams.get("api_key"), "custom-key");
});

test("Forward 中文搜索请求不重定向（无需修改 url/参数，走响应脚本处理）", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/search/movie?language=zh-CN&query=%E8%8B%B1%E9%9B%84%E6%97%A0%E5%BD%92", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.equal(result.$response, undefined);
});

test("Forward 中文 trending 请求不重定向（走响应脚本处理）", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/trending/movie/week?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.equal(result.$response, undefined);
});

test("Forward 英文请求不重定向（无需中文回填）", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/search/movie?language=en-US&query=spider-man", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.equal(result.$response, undefined);
});

test("Forward 中文请求 aliasFallback 关闭时不重定向", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/search/movie?language=zh-CN&query=test", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: false } });
	assert.equal(result.$response, undefined);
});

test("Forward 中文搜索响应会按条目补全中文片名，fetcher 请求 TMDB 而非 forwardinfo", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/search/movie?language=zh-CN&query=test", headers: { authorization: "Bearer signed-forward-token" } };
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			results: [
				{ id: 550, title: "Fight Club" },
				{ id: 11, title: "星球大战" },
			],
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true },
		fetcher: async aliasRequest => {
			fetched.push(aliasRequest);
			return { ok: true, status: 200, body: JSON.stringify({ alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] } }) };
		},
	});
	assert.equal(fetched.length, 1);
	assert.equal(fetched[0].url, "https://api.tmdb.org/3/movie/550?append_to_response=alternative_titles%2Cexternal_ids&language=zh-CN");
	assert.equal(fetched[0].headers.authorization, undefined);
	assert.deepEqual(
		JSON.parse(response.body).results.map(item => item.title),
		["搏击俱乐部", "星球大战"],
	);
});

test("电影详情 append credits 时使用豆瓣数据汉化角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: {
				cast: [
					{ id: 1, name: "爱德华·诺顿", character: "The Narrator" },
					{ id: 2, name: "布拉德·皮特", character: "Tyler Durden" },
				],
			},
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [
							{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" },
							{ name: "布拉德·皮特", simple_character: "饰 泰勒·德顿", category: "演员" },
						],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const body = JSON.parse(response.body);
	assert.equal(body.credits.cast[0].character, "旁白者");
	assert.equal(body.credits.cast[1].character, "泰勒·德顿");
	assert.ok(!fetched.some(url => url.includes("/external_ids")), "imdb_id from body should skip external_ids fetch");
});

test("有中文标题且有豆瓣角色名时缓存 30 天", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "搏击俱乐部",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_FULL_TTL_MS);
});

test("有中文别名且有豆瓣角色名时缓存 30 天", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			alternative_titles: { titles: [{ iso_3166_1: "CN", title: "搏击俱乐部" }] },
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_FULL_TTL_MS);
});

test("无中文标题和别名但有豆瓣角色名时缓存 7 天", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: true, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			alternative_titles: { titles: [{ iso_3166_1: "US", title: "Fight Club" }] },
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: true, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_TTL_MS);
});

test("有中文来源但无豆瓣角色名时缓存 7 天", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "搏击俱乐部",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.ok(entry);
	assert.equal(entry.expiresAt - entry.createdAt, CACHE_TTL_MS);
});

test("独立电影 credits 请求通过 external_ids 获取 imdb_id 后汉化角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }],
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("/movie/550/external_ids")) {
				return { ok: true, status: 200, body: JSON.stringify({ imdb_id: "tt0137523" }) };
			}
			if (req.url.includes("/movie/550?") && !req.url.includes("external_ids") && !req.url.includes("credits_stats") && !req.url.includes("search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ title: "Fight Club", origin_country: ["CN"] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const body = JSON.parse(response.body);
	assert.equal(body.cast[0].character, "旁白者");
	assert.ok(fetched.some(url => url.includes("/movie/550/external_ids")), "should fetch external_ids for imdb_id");
});

test("TV 详情 append credits 时使用豆瓣数据汉化角色名（含季数据）", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/1399?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: true, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Game of Thrones",
			imdb_id: "tt0944947",
			origin_country: ["CN"],
			aggregate_credits: {
				cast: [{ id: 1, name: "艾米莉亚·克拉克", roles: [{ character: "Daenerys Targaryen" }] }],
			},
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: true, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "3016187", target_type: "tv" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/tv/3016187/seasons")) {
				return { ok: true, status: 200, body: JSON.stringify({ seasons: [{ id: "26862749" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/3016187/credits_stats") || req.url.includes("frodo.douban.com/api/v2/movie/26862749/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "艾米莉亚·克拉克", simple_character: "饰 丹妮莉丝·坦格利安", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const body = JSON.parse(response.body);
	assert.equal(body.credits.cast[0].character, "丹妮莉丝·坦格利安");
});

test("非中文请求不汉化角色名", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=en-US", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "Edward Norton", character: "The Narrator" }] }),
	};
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		fetcher: async () => {
			fetchCount += 1;
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).cast[0].character, "The Narrator");
});

test("已有中文角色名不被覆盖", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "旁白者" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async () => ({ ok: true, status: 200, body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 其他角色", category: "演员" }] }) }),
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "旁白者");
});

test("characterTranslation 关闭时不汉化角色名", async () => {
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: false } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "Edward Norton", character: "The Narrator" }] }),
	};
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: false },
		fetcher: async () => {
			fetchCount += 1;
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).cast[0].character, "The Narrator");
});

test("配音角色名追加（配音）后缀", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "张三", character: "Voice" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "张三", simple_character: "配 孙悟空", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "孙悟空（配音）");
});

test("豆瓣职位值不被当作角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "张三", character: "" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [
							{ name: "张三", simple_character: "摄影指导", category: "摄影", roles: ["摄影", "演员"] },
							{ name: "李四", simple_character: "配音导演", category: "副导演", roles: ["演员", "配音", "副导演"] },
							{ name: "王五", simple_character: "原著作者", category: "编剧", roles: ["编剧", "演员"] },
							{ name: "张三", simple_character: "饰 安迪", category: "演员", roles: ["演员"] },
						],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "安迪");
});

test("TMDB 和豆瓣均无角色名时用'演员'占位", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "张三", character: "" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "张三", simple_character: "演员", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "演员");
});

test("TMDB 和豆瓣均无角色名时配音演员用'配音'占位", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "李四", character: "" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "李四", simple_character: "配音", category: "配音" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "配音");
});

test("非中日韩影片不汉化角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			imdb_id: "tt0137523",
			origin_country: ["US"],
			credits: { cast: [{ id: 1, name: "张三", character: "Hero" }] },
		}),
	};
	let doubanCalled = false;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com")) doubanCalled = true;
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "Hero");
	assert.equal(doubanCalled, false);
});

test("港澳台影片汉化角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			imdb_id: "tt0137523",
			title: "测试电影",
			origin_country: ["HK"],
			credits: { cast: [{ id: 1, name: "张三", character: "" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "张三", simple_character: "饰 主角", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "主角");
});

test("TMDB 有英文角色名时占位符不覆盖", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			imdb_id: "tt0137523",
			credits: { cast: [{ id: 1, name: "张三", character: "Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [{ name: "张三", simple_character: "演员", category: "演员" }],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "Narrator");
});

test("豆瓣有真角色名时移除占位符", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "张三", character: "" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({
						items: [
							{ name: "张三", simple_character: "饰 林冲", category: "演员" },
							{ name: "张三", simple_character: "演员", category: "演员" },
						],
					}),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "林冲");
});

test("豆瓣角色名缓存命中时不重复请求", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: {
					550: {
						imdbId: "tt0137523",
					doubanId: "1292052",
					characters: { "爱德华·诺顿": ["旁白者"] },
					originCountries: ["CN"],
					title: "搏击俱乐部",
					year: "1999",
						createdAt: now,
						expiresAt: now + CACHE_TTL_MS,
					},
				},
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] }),
	};
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async () => {
			fetchCount += 1;
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).cast[0].character, "旁白者");
});

test("IMDB ID 缓存命中时不请求 external_ids", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: {
					550: {
						imdbId: "tt0137523",
					doubanId: "1292052",
					characters: { "爱德华·诺顿": ["旁白者"] },
					originCountries: ["CN"],
					title: "搏击俱乐部",
					year: "1999",
						createdAt: now,
						expiresAt: now + CACHE_TTL_MS,
					},
				},
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] }),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			fetched.push(req.url);
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.ok(!fetched.some(url => url.includes("/external_ids")));
	assert.equal(JSON.parse(response.body).cast[0].character, "旁白者");
});

test("豆瓣 ID 缓存命中时不请求搜索接口", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: {
					550: {
						imdbId: "tt0137523",
					doubanId: "1292052",
					characters: { "爱德华·诺顿": ["旁白者"] },
					originCountries: ["CN"],
					title: "搏击俱乐部",
					year: "1999",
						createdAt: now,
						expiresAt: now + CACHE_TTL_MS,
					},
				},
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] }),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			fetched.push(req.url);
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.ok(!fetched.some(url => url.includes("frodo.douban.com/api/v2/search")));
	assert.equal(JSON.parse(response.body).cast[0].character, "旁白者");
});

test("豆瓣 API 失败时保持原角色名", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "Edward Norton", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async () => ({ ok: false, status: 500, body: "{}" }),
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "The Narrator");
});

test("统一缓存兼容别名和角色名", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: {
					550: {
						aliases: { CN: "搏击俱乐部" },
						imdbId: "tt0137523",
					doubanId: "1292052",
					characters: { "爱德华·诺顿": ["旁白者"] },
					originCountries: ["CN"],
					title: "搏击俱乐部",
					year: "1999",
						createdAt: now,
						expiresAt: now + CACHE_TTL_MS,
					},
				},
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] }),
	};
	let fetchCount = 0;
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async () => {
			fetchCount += 1;
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(fetchCount, 0);
	assert.equal(JSON.parse(response.body).cast[0].character, "旁白者");
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.deepEqual(entry.aliases, { CN: "搏击俱乐部" });
	assert.equal(entry.imdbId, "tt0137523");
	assert.equal(entry.doubanId, "1292052");
});

test("角色名汉化结果写入缓存供后续请求复用", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }] }),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.movie["550"];
	assert.equal(entry.imdbId, "tt0137523");
	assert.equal(entry.doubanId, "1292052");
	assert.deepEqual(entry.characters, { "爱德华·诺顿": ["旁白者"] });
});

test("zh-TW 请求将角色名转换为繁体", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-TW&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "Fight Club",
			imdb_id: "tt0137523",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "爱德华·诺顿", character: "The Narrator" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1292052", target_type: "movie" }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1292052/credits_stats")) {
				return {
					ok: true,
					status: 200,
					body: JSON.stringify({ items: [{ name: "爱德华·诺顿", simple_character: "饰 旁白者", category: "演员" }] }),
				};
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "旁白者");
});

test("imdbId 与名称并发搜索，imdbId 无结果时使用名称结果并按年份匹配", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "九门",
			release_date: "2026-01-01",
			imdb_id: "tt37118307",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "演员甲", character: "Character" }] },
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				const url = new URL(req.url);
				const q = url.searchParams.get("q");
				if (q === "tt37118307") return { ok: true, status: 200, body: JSON.stringify({ cards: [] }) };
				if (q === "九门") return {
					ok: true,
					status: 200,
					body: JSON.stringify({ cards: [
						{ target_id: "26614088", target_type: "movie", target: { title: "老九门", year: "2016" } },
						{ target_id: "1234567", target_type: "movie", target: { title: "九门", year: "2026" } },
					] }),
				};
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1234567/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "演员甲", simple_character: "饰 角色", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.ok(fetched.some(url => url.includes("q=tt37118307")), "should search by imdbId");
	assert.ok(fetched.some(url => url.includes("q=%E4%B9%9D%E9%97%A8")), "should search by name concurrently");
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "角色");
	assert.equal(storage.store.dj_tmdb_proxy_cache.stores.movie["550"].doubanId, "1234567", "should match by title and year");
});

test("imdbId 搜索有结果时优先使用 imdbId 结果", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			title: "九门",
			release_date: "2026-01-01",
			imdb_id: "tt37118307",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "演员甲", character: "Character" }] },
		}),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				const url = new URL(req.url);
				const q = url.searchParams.get("q");
				if (q === "tt37118307") return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "imdb-result", target_type: "movie", target: { title: "九门", year: "2026" } }] }) };
				if (q === "九门") return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "fallback-result", target_type: "movie", target: { title: "九门", year: "2026" } }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/imdb-result/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "演员甲", simple_character: "饰 imdb角色", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.equal(storage.store.dj_tmdb_proxy_cache.stores.movie["550"].doubanId, "imdb-result", "should prefer imdbId result");
	assert.equal(JSON.parse(response.body).credits.cast[0].character, "imdb角色");
});

test("独立 credits 请求时从详情接口获取标题用于 fallback 搜索", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "演员甲", character: "Character" }] }),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("/movie/550/external_ids")) return { ok: true, status: 200, body: JSON.stringify({ imdb_id: "tt37118307" }) };
			if (req.url.includes("/movie/550") && !req.url.includes("credits") && !req.url.includes("external_ids")) {
				return { ok: true, status: 200, body: JSON.stringify({ title: "九门", release_date: "2026-01-01", origin_country: ["CN"] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				const url = new URL(req.url);
				const q = url.searchParams.get("q");
				if (q === "tt37118307") return { ok: true, status: 200, body: JSON.stringify({ cards: [] }) };
				if (q === "九门") return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1234567", target_type: "movie", target: { title: "九门", year: "2026" } }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1234567/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "演员甲", simple_character: "饰 角色", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.ok(fetched.some(url => url.includes("/movie/550") && !url.includes("credits") && !url.includes("external_ids")), "should fetch detail for title");
	assert.ok(fetched.some(url => url.includes("q=%E4%B9%9D%E9%97%A8")), "should search by title from detail");
	assert.equal(JSON.parse(response.body).cast[0].character, "角色");
	assert.equal(storage.store.dj_tmdb_proxy_cache.stores.movie["550"].title, "九门");
	assert.equal(storage.store.dj_tmdb_proxy_cache.stores.movie["550"].year, "2026");
});

test("标题缓存命中时不请求详情接口", async () => {
	const now = 1_700_000_000_000;
	const storage = createMemoryStorage({
		dj_tmdb_proxy_cache: {
			version: 2,
			stores: {
				movie: {
					550: {
						title: "九门",
						year: "2026",
						imdbId: "tt37118307",
						createdAt: now,
						expiresAt: now + CACHE_TTL_MS,
					},
				},
				tv: {},
			},
		},
	});
	const request = { method: "GET", url: "https://api.themoviedb.org/3/movie/550/credits?language=zh-CN", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cast: [{ id: 1, name: "演员甲", character: "Character" }] }),
	};
	const fetched = [];
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		now,
		fetcher: async req => {
			fetched.push(req.url);
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				const url = new URL(req.url);
				const q = url.searchParams.get("q");
				if (q === "tt37118307") return { ok: true, status: 200, body: JSON.stringify({ cards: [] }) };
				if (q === "九门") return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1234567", target_type: "movie", target: { title: "九门", year: "2026" } }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/movie/1234567/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "演员甲", simple_character: "饰 角色", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	assert.ok(!fetched.some(url => url.includes("/movie/550") && !url.includes("credits") && !url.includes("external_ids")), "should not fetch detail when title cached");
	assert.ok(!fetched.some(url => url.includes("/movie/550/external_ids")), "should not fetch external_ids when cached");
});

test("fallback 搜索命中后缓存 doubanId 供后续请求复用", async () => {
	const storage = createMemoryStorage({ dj_tmdb_proxy_cache: createEmptyCache() });
	const request = { method: "GET", url: "https://api.themoviedb.org/3/tv/123456?language=zh-CN&append_to_response=credits", headers: {} };
	await applyTmdbRequestRules(request, { argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true } });
	const response = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "九门",
			first_air_date: "2026-01-01",
			imdb_id: "tt37118307",
			origin_country: ["CN"],
			credits: { cast: [{ id: 1, name: "演员甲", character: "Character" }] },
		}),
	};
	await applyTmdbResponseRules(request, response, {
		argument: { aliasFallback: false, aggregateCredits: false, characterTranslation: true },
		storage,
		fetcher: async req => {
			if (req.url.includes("frodo.douban.com/api/v2/search/suggestion")) {
				const url = new URL(req.url);
				const q = url.searchParams.get("q");
				if (q === "tt37118307") return { ok: true, status: 200, body: JSON.stringify({ cards: [] }) };
				if (q === "九门") return { ok: true, status: 200, body: JSON.stringify({ cards: [{ target_id: "1234567", target_type: "tv", target: { title: "九门", year: "2026" } }] }) };
			}
			if (req.url.includes("frodo.douban.com/api/v2/tv/1234567/seasons")) return { ok: true, status: 200, body: JSON.stringify({ seasons: [] }) };
			if (req.url.includes("frodo.douban.com/api/v2/movie/1234567/credits_stats")) {
				return { ok: true, status: 200, body: JSON.stringify({ items: [{ name: "演员甲", simple_character: "饰 角色", category: "演员" }] }) };
			}
			return { ok: false, status: 404, body: "{}" };
		},
	});
	const entry = storage.store.dj_tmdb_proxy_cache.stores.tv["123456"];
	assert.equal(entry.doubanId, "1234567");
});
