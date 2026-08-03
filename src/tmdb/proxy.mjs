import { fetch as utilFetch, Storage } from "../runtime/script.mjs";
import { applyChineseAliasFallback, applyChineseAliasFallbackToList } from "./aliases.mjs";
import { applyCharacterTranslation } from "./characters.mjs";
import { BlobCacheStore, RemoteCacheStore, TieredCacheStore } from "./cache-store.mjs";
import { resolveProxyConfig } from "./config.mjs";
import { normalizeAggregateCredits } from "./credits.mjs";
import { applyTmdbRequestRules, DEFAULT_TMDB_API_KEY, encodeState, fetchTmdbWithNativeFetch, STATE_HEADER } from "./request-rules.mjs";

function getDefaultFetcher() {
	return globalThis.$task || globalThis.$httpClient ? utilFetch : fetchTmdbWithNativeFetch;
}

// 根据配置创建缓存存储：配置了 cacheBackend 时用 TieredCacheStore（本地 + HTTP 远端），否则仅本地。
// Creates cache store based on config: TieredCacheStore (local + HTTP remote) when cacheBackend is set, otherwise local only.
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
	} catch {
		return {};
	}
}

function setHeader(headers, key, value) {
	headers[key] = value;
}

function readHeader(headers, key) {
	const lower = key.toLowerCase();
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (name.toLowerCase() === lower) return Array.isArray(value) ? value[0] : value;
	}
	return undefined;
}

function deleteHeader(headers, key) {
	const lower = key.toLowerCase();
	for (const name of Object.keys(headers ?? {})) {
		if (name.toLowerCase() === lower) headers[name] = undefined;
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
	try {
		let body = JSON.parse(response.body ?? "{}");
		if (state.aggregateCreditsRewrite) body = normalizeAggregateCredits(body);
		if (state.appendCreditsRewrite && body?.aggregate_credits) {
			body.credits = normalizeAggregateCredits(body.aggregate_credits);
			if (!state.hadClientAggregateCreditsAppend) body.aggregate_credits = undefined;
		}
		// 客户端直接请求了 aggregate_credits 但没有 credits 时，生成临时 credits 用于角色名汉化。
		// Client directly requested aggregate_credits without credits: generate temporary credits for character translation.
		const generatedCreditsFromAggregate = Boolean(body?.aggregate_credits && !body?.credits);
		if (generatedCreditsFromAggregate) {
			body.credits = normalizeAggregateCredits(body.aggregate_credits);
		}
		body = await applyChineseAliasFallback(request.url, body, {
			aliasFallback: config.aliasFallback,
			hadClientAlternativeTitles: Boolean(state.hadClientAlternativeTitles),
			hadClientTranslations: Boolean(state.hadClientTranslations),
			cacheStore,
			now: options.now,
			waitUntil: options.waitUntil,
		});
		body = await applyChineseAliasFallbackToList(request, body, {
			aliasFallback: config.aliasFallback,
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
		});
		// 将汉化结果写回 aggregate_credits 的 roles，删除临时生成的 credits。
		// Write translated characters back to aggregate_credits roles, remove temporary credits.
		if (generatedCreditsFromAggregate) {
			const creditsMap = new Map((body.credits?.cast ?? []).map(c => [c.id, c.character]));
			for (const castItem of body.aggregate_credits?.cast ?? []) {
				const character = creditsMap.get(castItem.id);
				if (character && Array.isArray(castItem.roles)) {
					for (const role of castItem.roles) role.character = character;
				}
			}
			delete body.credits;
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
	request.headers ??= {};
	setHeader(request.headers, "Authorization", `Bearer ${token}`);
	return request;
}

export { applyTmdbRequestRules, applyTmdbResponseRules, DEFAULT_TMDB_API_KEY, decodeState, encodeState, fetchTmdbWithNativeFetch, injectTmdbCredential, STATE_HEADER };
