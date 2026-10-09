import { Storage, fetch as utilFetch } from "../runtime/script.mjs";
import { applyChineseAliasFallback, applyChineseAliasFallbackToList } from "./aliases.mjs";
import { createTmdbApiKeyProvider } from "./api-key.mjs";
import { BlobCacheStore, RemoteCacheStore, TieredCacheStore } from "./cache-store.mjs";
import { applyCharacterTranslation } from "./characters.mjs";
import { resolveProxyConfig } from "./config.mjs";
import { normalizeAggregateCredits } from "./credits.mjs";
import { applyGenreTranslation } from "./genres.mjs";
import { deleteHeader, readHeader, STATE_HEADER, setHeader } from "./headers.mjs";
import { applyTmdbRequestRules, encodeState, fetchTmdbWithNativeFetch } from "./request-rules.mjs";
import { isTmdbImageRequest } from "./routes.mjs";

function getDefaultFetcher() {
	return globalThis.$task || globalThis.$httpClient ? utilFetch : fetchTmdbWithNativeFetch;
}

// 根据配置创建缓存存储：配置了 cacheBackend 时用 TieredCacheStore（本地 + HTTP 远端），否则仅本地。
function createCacheStore(config, storage) {
	const local = new BlobCacheStore(storage ?? Storage);
	const remoteUrl = config?.cacheBackend;
	if (!remoteUrl) return local;
	return new TieredCacheStore(local, new RemoteCacheStore(remoteUrl, getDefaultFetcher()));
}

function decodeState(value) {
	if (!value) return {};
	try {
		return JSON.parse(decodeURIComponent(String(value)));
	} catch (error) {
		console.warn("[tmdb-proxy] 代理状态头解析失败", error?.message ?? error);
		return {};
	}
}

function isJsonResponse(response) {
	return String(readHeader(response.headers, "content-type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase()
		.endsWith("json");
}

async function applyTmdbResponseRules(request, response, options = {}) {
	if (!isJsonResponse(response)) return response;
	const state = { ...decodeState(readHeader(request.headers, STATE_HEADER)), ...options.state };
	deleteHeader(request.headers, STATE_HEADER);
	const config = resolveProxyConfig({ argument: options.argument, env: options.env });
	const cacheStore = options.cacheStore ?? createCacheStore(config, options.storage);
	const apiKeyProvider =
		options.apiKeyProvider ??
		createTmdbApiKeyProvider({
			env: options.env,
			backendUrl: config.cacheBackend,
			storage: options.storage,
			now: options.now,
		});
	// TMDB 返回 401 且失败的是本代理注入的 key，才向后端拉取最新 key；客户端自带凭证或 Forward 反代自身的 401 不处理。
	if (response.status === 401 && apiKeyProvider.isOwnKey(new URL(request.url).searchParams.get("api_key"))) await apiKeyProvider.handleUnauthorized(options.waitUntil);
	try {
		let body = JSON.parse(response.body ?? "{}");
		if (state.aggregateCreditsRewrite) body = normalizeAggregateCredits(body);
		if (state.appendCreditsRewrite && body?.aggregate_credits) {
			body.credits = normalizeAggregateCredits(body.aggregate_credits);
			if (!state.hadClientAggregateCreditsAppend) body.aggregate_credits = undefined;
		}
		// 客户端直接请求了 aggregate_credits 但没有 credits 时，生成临时 credits 用于角色名汉化。
		const generatedCreditsFromAggregate = Boolean(body?.aggregate_credits && !body?.credits);
		if (generatedCreditsFromAggregate) {
			body.credits = normalizeAggregateCredits(body.aggregate_credits);
		}
		body = await applyChineseAliasFallback(request.url, body, {
			aliasFallback: config.aliasFallback,
			characterTranslation: config.characterTranslation,
			hadClientAlternativeTitles: Boolean(state.hadClientAlternativeTitles),
			hadClientTranslations: Boolean(state.hadClientTranslations),
			hadClientExternalIds: Boolean(state.hadClientExternalIds),
			cacheStore,
			now: options.now,
			waitUntil: options.waitUntil,
		});
		body = await applyChineseAliasFallbackToList(request, body, {
			aliasFallback: config.aliasFallback,
			env: options.env,
			apiKeyProvider,
			fetcher: options.fetcher ?? getDefaultFetcher(),
			cacheStore,
			now: options.now,
			waitUntil: options.waitUntil,
		});
		body = await applyCharacterTranslation(request, body, {
			characterTranslation: config.characterTranslation,
			fetcher: options.fetcher ?? getDefaultFetcher(),
			cacheStore,
			now: options.now,
			waitUntil: options.waitUntil,
			env: options.env,
			apiKeyProvider,
		});
		// TMDB 部分类型（如 TV 科幻奇幻/战争政治）无中文翻译时返回英文，按请求语言兜底为中文。
		body = applyGenreTranslation(request, body);
		// 将汉化结果写回 aggregate_credits 的 roles，删除临时生成的 credits。
		if (generatedCreditsFromAggregate) {
			const creditsMap = new Map((body.credits?.cast ?? []).map(c => [c.id, c.character]));
			for (const castItem of body.aggregate_credits?.cast ?? []) {
				const character = creditsMap.get(castItem.id);
				if (character && Array.isArray(castItem.roles)) {
					for (const role of castItem.roles) role.character = character;
				}
			}
			body.credits = undefined;
		}
		response.body = JSON.stringify(body);
		deleteHeader(response.headers, "content-length");
		deleteHeader(response.headers, "content-encoding");
	} catch (error) {
		console.error(error);
		return response;
	}
	return response;
}

function hasClientCredential(request) {
	const url = new URL(request.url);
	return Boolean(url.searchParams.get("api_key") || readHeader(request.headers, "authorization"));
}

function injectTmdbCredential(request, token) {
	if (!token || hasClientCredential(request)) return request;
	// 图片 CDN 不接受也不需要凭证，跳过注入，避免把 v4 Token 发到 image.tmdb.org。
	if (isTmdbImageRequest(request.url)) return request;
	request.headers ??= {};
	setHeader(request.headers, "Authorization", `Bearer ${token}`);
	return request;
}

export { applyTmdbRequestRules, applyTmdbResponseRules, decodeState, encodeState, fetchTmdbWithNativeFetch, injectTmdbCredential, STATE_HEADER };
