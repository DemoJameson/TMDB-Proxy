import { ConverterFactory } from "opencc-js/core";
import HKVariants from "opencc-js/dict/HKVariants";
import HKVariantsPhrases from "opencc-js/dict/HKVariantsPhrases";
import STCharacters from "opencc-js/dict/STCharacters";
import TSCharacters from "opencc-js/dict/TSCharacters";
import TWVariants from "opencc-js/dict/TWVariants";
import TWVariantsPhrases from "opencc-js/dict/TWVariantsPhrases";
import { createTmdbApiKeyProvider } from "./api-key.mjs";
import { CACHE_NEGATIVE_TTL_MS, CACHE_TTL_MS } from "./cache.mjs";
import { fireCacheWrite } from "./cache-store.mjs";
import { buildSubRequestHeaders } from "./headers.mjs";
import { buildMediaDetailUrl, getRequestLanguage, hasHan, isChineseLanguage, isForwardHost, isTmdbCompatiblePath, parseTmdbRoute, rewriteForwardToTmdbUrl } from "./routes.mjs";

const LANGUAGE_REGIONS = {
	zh: ["CN", "SG", "TW", "HK"],
	"zh-cn": ["CN", "SG", "TW", "HK"],
	"zh-sg": ["SG", "CN", "TW", "HK"],
	"zh-tw": ["TW", "HK", "CN", "SG"],
	"zh-hk": ["HK", "TW", "CN", "SG"],
	"zh-hans-cn": ["CN", "SG", "TW", "HK"],
	"zh-hans-sg": ["SG", "CN", "TW", "HK"],
	"zh-hant-tw": ["TW", "HK", "CN", "SG"],
	"zh-hant-hk": ["HK", "TW", "CN", "SG"],
};

const converters = {
	cn: ConverterFactory([TSCharacters]),
	tw: ConverterFactory([STCharacters], [TWVariantsPhrases, TWVariants]),
	hk: ConverterFactory([STCharacters], [HKVariantsPhrases, HKVariants]),
};

function normalizeLanguage(language) {
	return String(language || "zh").toLowerCase();
}

function getPreferredRegions(language) {
	return LANGUAGE_REGIONS[normalizeLanguage(language)] ?? LANGUAGE_REGIONS.zh;
}

function getConverterTarget(language) {
	const normalized = normalizeLanguage(language);
	if (normalized === "zh-tw" || normalized === "zh-hant-tw") return "tw";
	if (normalized === "zh-hk" || normalized === "zh-hant-hk") return "hk";
	return "cn";
}

function convertChinese(value, language) {
	const converter = converters[getConverterTarget(language)];
	return converter ? converter(String(value)) : String(value);
}

function readAlternativeTitles(body, mediaType) {
	const container = body?.alternative_titles;
	if (!container || typeof container !== "object") return [];
	if (mediaType === "movie") return Array.isArray(container.titles) ? container.titles : [];
	if (mediaType === "tv") return Array.isArray(container.results) ? container.results : [];
	return [];
}

function pickChineseAlias(titles, language) {
	const chineseTitles = titles.filter(item => hasHan(item?.title));
	if (chineseTitles.length === 0) return "";
	const regions = getPreferredRegions(language);
	for (const region of regions) {
		const exact = chineseTitles.find(item => String(item?.iso_3166_1 ?? "").toUpperCase() === region);
		if (exact?.title) return convertChinese(exact.title, language);
	}
	return convertChinese(chineseTitles[0].title, language);
}

function extractRegionalAliases(titles) {
	const aliases = {};
	for (const region of ["CN", "SG", "TW", "HK"]) {
		const title = titles.find(item => String(item?.iso_3166_1 ?? "").toUpperCase() === region && hasHan(item?.title));
		if (title?.title) aliases[region] = title.title;
	}
	return aliases;
}

function pickChineseAliasFromRegions(aliases, language) {
	const regions = getPreferredRegions(language);
	for (const region of regions) {
		if (aliases?.[region]) return convertChinese(aliases[region], language);
	}
	return "";
}

function removeAutoAlternativeTitles(body, hadClientAlternativeTitles) {
	if (hadClientAlternativeTitles || !body || typeof body !== "object") return body;
	const { alternative_titles, ...cleanedBody } = body;
	void alternative_titles;
	return cleanedBody;
}

function removeAutoExternalIds(body, hadClientExternalIds) {
	if (hadClientExternalIds || !body || typeof body !== "object") return body;
	const { external_ids, ...cleanedBody } = body;
	void external_ids;
	return cleanedBody;
}

function readTranslations(body) {
	return Array.isArray(body?.translations) ? body.translations : [];
}

function pickChineseTranslation(translations, language) {
	const regions = getPreferredRegions(language);
	for (const region of regions) {
		const translation = translations.find(item => String(item?.iso_3166_1 ?? "").toUpperCase() === region && hasHan(item?.data?.title));
		if (translation?.data?.title) return convertChinese(translation.data.title, language);
	}
	return "";
}

function removeAutoTranslations(body, hadClientTranslations) {
	if (hadClientTranslations || !body || typeof body !== "object") return body;
	const { translations, ...cleanedBody } = body;
	void translations;
	return cleanedBody;
}

async function applyChineseAliasFallback(requestUrl, body, options = {}) {
	const route = parseTmdbRoute(requestUrl);
	if (!route?.isDetail || !(options.aliasFallback || options.characterTranslation)) return body;
	const language = getRequestLanguage(route.url);
	if (!isChineseLanguage(language)) return body;
	if (route.isCollectionDetail) {
		if (!options.aliasFallback) return body;
		if (!hasHan(body?.name)) {
			const translation = pickChineseTranslation(readTranslations(body), language);
			if (translation) body.name = translation;
		}
		return removeAutoTranslations(body, options.hadClientTranslations);
	}
	const titleField = route.mediaType === "movie" ? "title" : "name";
	const titles = readAlternativeTitles(body, route.mediaType);
	const aliases = extractRegionalAliases(titles);
	// 从详情响应提取角色名汉化所需字段（imdbId、originCountries、title、year），在详情接口响应时即缓存。
	// Extract character-translation fields (imdbId, originCountries, title, year) from detail response and cache at detail response time.
	const detailFields = extractDetailCacheFields(body, route.mediaType);

	const cacheStore = options.cacheStore;
	const hasDetailFields = Object.keys(detailFields).length > 0;
	const cacheData = { aliases, ...detailFields };
	const hasCacheData = Object.keys(aliases).length > 0 || hasDetailFields;
	if (options.aliasFallback) {
		const ttl = hasCacheData ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
		await fireCacheWrite(cacheStore?.merge(route.mediaType, route.mediaId, cacheData, ttl, options.now), options.waitUntil);
	} else if (hasCacheData) {
		await fireCacheWrite(cacheStore?.merge(route.mediaType, route.mediaId, cacheData, CACHE_TTL_MS, options.now), options.waitUntil);
	}
	if (options.aliasFallback) {
		if (!hasHan(body?.[titleField])) {
			const alias = pickChineseAlias(titles, language);
			if (alias) body[titleField] = alias;
		}
	}
	body = removeAutoAlternativeTitles(body, options.hadClientAlternativeTitles);
	body = removeAutoExternalIds(body, options.hadClientExternalIds);
	return body;
}

function inferListItemMediaType(item) {
	if (item?.media_type === "movie" || item?.media_type === "tv") return item.media_type;
	if (item?.media_type) return undefined;
	if (Object.hasOwn(item ?? {}, "title")) return "movie";
	if (Object.hasOwn(item ?? {}, "name")) return "tv";
	return undefined;
}

function getTitleFieldForMediaType(mediaType) {
	if (mediaType === "movie") return "title";
	if (mediaType === "tv") return "name";
	return undefined;
}

function getListItemsForAliasFallback(requestUrl, body) {
	if (Array.isArray(body?.results)) return body.results;
	const route = parseTmdbRoute(requestUrl);
	if (route?.isCollectionDetail && Array.isArray(body?.parts)) return body.parts;
	return undefined;
}

function isTmdbListResponse(requestUrl, body, options = {}) {
	if (!options.aliasFallback || !body || !getListItemsForAliasFallback(requestUrl, body)) return false;
	const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
	if (isForwardHost(url.hostname)) return isChineseLanguage(getRequestLanguage(url));
	return isTmdbCompatiblePath(url) && isChineseLanguage(getRequestLanguage(url));
}

export function extractFallbackInfoFromBody(body, mediaType) {
	const titleField = mediaType === "movie" ? "title" : "name";
	const dateField = mediaType === "movie" ? "release_date" : "first_air_date";
	const title = String(body?.[titleField] ?? "").trim();
	if (!title) return { title: "", year: "" };
	const date = String(body?.[dateField] ?? "").trim();
	const year = date.length >= 4 && /^\d{4}/.test(date) ? date.substring(0, 4) : "";
	return { title, year };
}

// 从响应体提取制片地区（origin_country 优先，回退到 production_countries）。
// Extracts production countries from body (origin_country first, then production_countries).
export function extractOriginCountries(body) {
	const countries = Array.isArray(body?.origin_country) ? body.origin_country : [];
	if (countries.length > 0) return countries.map(c => String(c ?? "").trim().toUpperCase()).filter(Boolean);
	if (Array.isArray(body?.production_countries)) {
		return body.production_countries.map(c => String(c?.iso_3166_1 ?? "").trim().toUpperCase()).filter(Boolean);
	}
	return [];
}

// 从详情响应体提取角色名汉化所需字段（imdbId、title、year、originCountries），供缓存合并使用。
// Extracts character-translation fields (imdbId, title, year, originCountries) from a detail response body for cache merging.
function extractDetailCacheFields(body, mediaType) {
	const fields = {};
	const { title, year } = extractFallbackInfoFromBody(body, mediaType);
	const originCountries = extractOriginCountries(body);
	const imdbId = String(body?.imdb_id ?? body?.external_ids?.imdb_id ?? "").trim();
	if (imdbId) fields.imdbId = imdbId;
	if (title) {
		fields.title = title;
		fields.year = year;
	}
	if (originCountries.length > 0) fields.originCountries = originCountries;
	return fields;
}

function createListDetailRequest(sourceRequest, mediaType, mediaId, language, apiKey) {
	const sourceUrl = new URL(sourceRequest.url);
	const isForward = rewriteForwardToTmdbUrl(sourceUrl);
	const url = buildMediaDetailUrl(sourceUrl, mediaType, mediaId);
	url.searchParams.set("append_to_response", "alternative_titles,external_ids");
	if (language && !url.searchParams.get("language")) url.searchParams.set("language", language);
	if (apiKey && !url.searchParams.get("api_key")) url.searchParams.set("api_key", apiKey);
	return {
		method: "GET",
		url: url.toString(),
		headers: buildSubRequestHeaders(sourceRequest, isForward),
	};
}

// 发送列表条目的详情子请求，网络错误仅告警，不影响整个列表响应。
// Sends the detail subrequest for a list item; network errors are only logged and do not break the list response.
async function requestListDetail(fetcher, detailRequest, mediaType, mediaId) {
	return await fetcher(detailRequest).catch(error => {
		console.warn(`[tmdb-proxy] 列表别名详情请求失败: ${mediaType}/${mediaId}`, error?.message ?? error);
		return undefined;
	});
}

// 详情子请求遇到 401，且失败的是本代理注入的 key 时刷新 key 并重试一次，使当前列表也能补全中文。
// Retries a detail subrequest once after refreshing the key, only when TMDB rejected the key this proxy injected.
async function fetchListDetail(fetcher, buildRequest, mediaType, mediaId, apiKeyProvider, waitUntil) {
	const apiKey = await apiKeyProvider.get();
	const detailRequest = buildRequest(apiKey);
	const response = await requestListDetail(fetcher, detailRequest, mediaType, mediaId);
	if (response?.status !== 401) return response;
	if (!apiKeyProvider.isOwnKey(new URL(detailRequest.url).searchParams.get("api_key"))) return response;
	const refreshedKey = await apiKeyProvider.handleUnauthorized(waitUntil);
	if (!refreshedKey || refreshedKey === apiKey) return response;
	return await requestListDetail(fetcher, buildRequest(refreshedKey), mediaType, mediaId);
}

async function mapWithConcurrency(items, limit, iteratee) {
	const executing = new Set();
	for (const item of items) {
		const task = Promise.resolve().then(() => iteratee(item));
		executing.add(task);
		task.finally(() => executing.delete(task));
		if (executing.size >= limit) await Promise.race(executing);
	}
	await Promise.all(executing);
}

async function applyChineseAliasFallbackToList(request, body, options = {}) {
	if (!isTmdbListResponse(request.url, body, options)) return body;
	const items = getListItemsForAliasFallback(request.url, body);
	const language = getRequestLanguage(new URL(request.url));
	const fetcher = options.fetcher;
	const cacheStore = options.cacheStore;
	const apiKeyProvider = options.apiKeyProvider ?? createTmdbApiKeyProvider({ env: options.env, storage: options.storage, now: options.now });
	if (typeof fetcher !== "function" || !cacheStore) return body;
	const pendingItems = [];
	for (const item of items) {
		const mediaType = inferListItemMediaType(item);
		const titleField = getTitleFieldForMediaType(mediaType);
		if (!titleField || !item?.id || hasHan(item[titleField])) continue;
		pendingItems.push({ item, mediaType, titleField });
	}
	if (pendingItems.length === 0) return body;
	const idsByMediaType = new Map();
	for (const { item, mediaType } of pendingItems) {
		if (!idsByMediaType.has(mediaType)) idsByMediaType.set(mediaType, []);
		idsByMediaType.get(mediaType).push(String(item.id));
	}
	const cacheEntries = new Map();
	for (const [mediaType, ids] of idsByMediaType) {
		const entries = await cacheStore.getManyWithFields(mediaType, ids, ["aliases"], options.now);
		for (const [id, entry] of entries) cacheEntries.set(`${mediaType}:${id}`, entry);
	}
	const newEntries = [];
	await mapWithConcurrency(pendingItems, options.concurrency ?? 10, async ({ item, mediaType, titleField }) => {
		const cached = cacheEntries.get(`${mediaType}:${item.id}`);
		if (cached) {
			const alias = pickChineseAliasFromRegions(cached.aliases, language);
			if (alias) item[titleField] = alias;
			return;
		}
		const detailResponse = await fetchListDetail(
			fetcher,
			apiKey => createListDetailRequest(request, mediaType, item.id, language, apiKey),
			mediaType,
			item.id,
			apiKeyProvider,
			options.waitUntil,
		);
		if (!detailResponse?.ok && !(detailResponse?.status >= 200 && detailResponse?.status < 300)) return;
		try {
			const detailBody = JSON.parse(detailResponse.body ?? "{}");
			const titles = readAlternativeTitles(detailBody, mediaType);
			const aliases = extractRegionalAliases(titles);
			const alias = pickChineseAliasFromRegions(aliases, language);
			// 从详情响应提取全部字段并缓存
			// Extract all detail fields from detail response and cache
			const detailFields = extractDetailCacheFields(detailBody, mediaType);
			const cacheData = { aliases, ...detailFields };
			const hasData = Object.keys(aliases).length > 0 || Object.keys(detailFields).length > 0;
			const ttl = hasData ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
			newEntries.push({ mediaType, id: String(item.id), data: cacheData, ttlMs: ttl });
			if (alias) item[titleField] = alias;
		} catch (error) {
			console.warn(`[tmdb-proxy] 列表别名详情响应解析失败: ${mediaType}/${item.id}`, error?.message ?? error);
			return;
		}
	});
	if (newEntries.length > 0) await fireCacheWrite(cacheStore.setMany(newEntries, options.now), options.waitUntil);
	return body;
}

export {
	applyChineseAliasFallback,
	applyChineseAliasFallbackToList,
	convertChinese,
	createListDetailRequest,
	extractRegionalAliases,
	getPreferredRegions,
	inferListItemMediaType,
	pickChineseAlias,
	pickChineseAliasFromRegions,
	pickChineseTranslation,
	readAlternativeTitles,
	readTranslations,
};
