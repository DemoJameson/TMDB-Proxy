import { ConverterFactory } from "opencc-js/core";
import HKVariants from "opencc-js/dict/HKVariants";
import HKVariantsPhrases from "opencc-js/dict/HKVariantsPhrases";
import STCharacters from "opencc-js/dict/STCharacters";
import TSCharacters from "opencc-js/dict/TSCharacters";
import TWVariants from "opencc-js/dict/TWVariants";
import TWVariantsPhrases from "opencc-js/dict/TWVariantsPhrases";
import { CACHE_NEGATIVE_TTL_MS, CACHE_TTL_MS } from "./cache.mjs";
import { fireCacheWrite } from "./cache-store.mjs";
import { buildAlternativeTitlesUrl, getRequestLanguage, isChineseLanguage, isForwardHost, isTmdbCompatiblePath, parseTmdbRoute } from "./routes.mjs";

const HAN_REGEX = /[\u3400-\u9fff]/;
const LANGUAGE_REGIONS = {
	zh: ["CN", "SG", "TW", "HK"],
	"zh-cn": ["CN", "SG", "TW", "HK"],
	"zh-sg": ["SG", "CN", "TW", "HK"],
	"zh-tw": ["TW", "HK", "CN", "SG"],
	"zh-hk": ["HK", "TW", "CN", "SG"],
};

const converters = {
	cn: ConverterFactory([TSCharacters]),
	tw: ConverterFactory([STCharacters], [TWVariantsPhrases, TWVariants]),
	hk: ConverterFactory([STCharacters], [HKVariantsPhrases, HKVariants]),
};

function hasHan(value) {
	return HAN_REGEX.test(String(value ?? ""));
}

function normalizeLanguage(language) {
	return String(language || "zh").toLowerCase();
}

function getPreferredRegions(language) {
	return LANGUAGE_REGIONS[normalizeLanguage(language)] ?? LANGUAGE_REGIONS.zh;
}

function getConverterTarget(language) {
	const normalized = normalizeLanguage(language);
	if (normalized === "zh-tw") return "tw";
	if (normalized === "zh-hk") return "hk";
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
	if (!route?.isDetail || !options.aliasFallback) return body;
	const language = getRequestLanguage(route.url);
	if (!isChineseLanguage(language)) return body;
	if (route.isCollectionDetail) {
		if (!hasHan(body?.name)) {
			const translation = pickChineseTranslation(readTranslations(body), language);
			if (translation) body.name = translation;
		}
		return removeAutoTranslations(body, options.hadClientTranslations);
	}
	const titleField = route.mediaType === "movie" ? "title" : "name";
	const titles = readAlternativeTitles(body, route.mediaType);
	const aliases = extractRegionalAliases(titles);
	const cacheStore = options.cacheStore;
	const ttl = Object.keys(aliases).length > 0 ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
	await fireCacheWrite(cacheStore?.merge(route.mediaType, route.mediaId, { aliases }, ttl, options.now), options.waitUntil);
	if (!hasHan(body?.[titleField])) {
		const alias = pickChineseAlias(titles, language);
		if (alias) body[titleField] = alias;
	}
	return removeAutoAlternativeTitles(body, options.hadClientAlternativeTitles);
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

function readFetchedAlternativeTitles(body, mediaType) {
	if (mediaType === "movie") return Array.isArray(body?.titles) ? body.titles : [];
	if (mediaType === "tv") return Array.isArray(body?.results) ? body.results : [];
	return [];
}

function isTmdbListResponse(requestUrl, body, options = {}) {
	if (!options.aliasFallback || !body || !getListItemsForAliasFallback(requestUrl, body)) return false;
	const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
	if (isForwardHost(url.hostname)) return isChineseLanguage(getRequestLanguage(url));
	return isTmdbCompatiblePath(url) && isChineseLanguage(getRequestLanguage(url));
}

function createListAliasRequest(sourceRequest, mediaType, mediaId) {
	const sourceUrl = new URL(sourceRequest.url);
	const isForward = isForwardHost(sourceUrl.hostname);
	if (isForward) {
		sourceUrl.host = "api.tmdb.org";
		sourceUrl.pathname = `/3${sourceUrl.pathname}`;
		sourceUrl.search = "";
	}
	const url = buildAlternativeTitlesUrl(sourceUrl, mediaType, mediaId);
	const headers = Object.fromEntries(Object.entries(sourceRequest.headers ?? {}).filter(([key]) => key.toLowerCase() !== "x-tmdb-proxy-state"));
	if (isForward) {
		delete headers.authorization;
	}
	return {
		method: "GET",
		url: url.toString(),
		headers,
	};
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
		const aliasResponse = await fetcher(createListAliasRequest(request, mediaType, item.id)).catch(() => undefined);
		if (!aliasResponse?.ok && !(aliasResponse?.status >= 200 && aliasResponse?.status < 300)) return;
		try {
			const aliasBody = JSON.parse(aliasResponse.body ?? "{}");
			const aliases = extractRegionalAliases(readFetchedAlternativeTitles(aliasBody, mediaType));
			const alias = pickChineseAliasFromRegions(aliases, language);
			const ttl = Object.keys(aliases).length > 0 ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
			newEntries.push({ mediaType, id: String(item.id), data: { aliases }, ttlMs: ttl });
			if (alias) item[titleField] = alias;
		} catch {
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
	createListAliasRequest,
	extractRegionalAliases,
	getPreferredRegions,
	hasHan,
	inferListItemMediaType,
	pickChineseAlias,
	pickChineseAliasFromRegions,
	pickChineseTranslation,
	readAlternativeTitles,
	readFetchedAlternativeTitles,
	readTranslations,
};
