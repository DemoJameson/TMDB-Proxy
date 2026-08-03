import { convertChinese, hasHan } from "./aliases.mjs";
import { fetchDoubanCreditsStats, fetchDoubanSeasons, mergeDoubanCredits, normalizeDoubanCreditsPayload, searchDoubanSubject } from "./douban.mjs";
import { CACHE_NEGATIVE_TTL_MS, CACHE_TTL_MS } from "./cache.mjs";
import { fireCacheWrite } from "./cache-store.mjs";
import { buildExternalIdsUrl, buildMediaDetailUrl, getRequestLanguage, isChineseLanguage, isForwardHost, parseTmdbRoute } from "./routes.mjs";
import { DEFAULT_TMDB_API_KEY, STATE_HEADER } from "./request-rules.mjs";

// 中日韩制片地区（含港澳台）。
// CJK production regions (including HK, MO, TW).
const CJK_COUNTRIES = new Set(["CN", "JP", "KR", "HK", "TW", "MO"]);

function isCjkProduction(originCountries) {
	return Array.isArray(originCountries) && originCountries.some(country => CJK_COUNTRIES.has(country));
}

function createExternalIdsRequest(sourceRequest, mediaType, mediaId) {
	const sourceUrl = new URL(sourceRequest.url);
	const isForward = isForwardHost(sourceUrl.hostname);
	if (isForward) {
		sourceUrl.host = "api.tmdb.org";
		sourceUrl.pathname = `/3${sourceUrl.pathname}`;
		sourceUrl.search = "";
	}
	const url = buildExternalIdsUrl(sourceUrl, mediaType, mediaId);
	if (!url.searchParams.get("api_key") && isForward) url.searchParams.set("api_key", DEFAULT_TMDB_API_KEY);
	const headers = Object.fromEntries(Object.entries(sourceRequest.headers ?? {}).filter(([key]) => key.toLowerCase() !== STATE_HEADER));
	if (isForward) delete headers.authorization;
	return { method: "GET", url: url.toString(), headers };
}

function createMediaDetailRequest(sourceRequest, mediaType, mediaId, language) {
	const sourceUrl = new URL(sourceRequest.url);
	const isForward = isForwardHost(sourceUrl.hostname);
	if (isForward) {
		sourceUrl.host = "api.tmdb.org";
		sourceUrl.pathname = `/3${sourceUrl.pathname}`;
		sourceUrl.search = "";
	}
	const url = buildMediaDetailUrl(sourceUrl, mediaType, mediaId);
	if (language) url.searchParams.set("language", language);
	if (!url.searchParams.get("api_key") && isForward) url.searchParams.set("api_key", DEFAULT_TMDB_API_KEY);
	const headers = Object.fromEntries(Object.entries(sourceRequest.headers ?? {}).filter(([key]) => key.toLowerCase() !== STATE_HEADER));
	if (isForward) delete headers.authorization;
	return { method: "GET", url: url.toString(), headers };
}

async function resolveImdbId(route, body, request, fetcher, entry) {
	const bodyImdbId = String(body?.imdb_id ?? "").trim();
	if (bodyImdbId) {
		entry.imdbId = bodyImdbId;
		return bodyImdbId;
	}
	if (entry.imdbId !== undefined) return entry.imdbId || null;
	const externalIdsResponse = await fetcher(createExternalIdsRequest(request, route.mediaType, route.mediaId)).catch(() => undefined);
	let imdbId = "";
	if (externalIdsResponse?.ok || (externalIdsResponse?.status >= 200 && externalIdsResponse?.status < 300)) {
		try {
			const payload = JSON.parse(externalIdsResponse.body ?? "{}");
			imdbId = String(payload?.imdb_id ?? "").trim();
		} catch {
			// ignore parse error
		}
	}
	entry.imdbId = imdbId;
	return imdbId || null;
}

function extractFallbackInfoFromBody(body, mediaType) {
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
function extractOriginCountries(body) {
	const countries = Array.isArray(body?.origin_country) ? body.origin_country : [];
	if (countries.length > 0) return countries.map(c => String(c ?? "").trim().toUpperCase()).filter(Boolean);
	if (Array.isArray(body?.production_countries)) {
		return body.production_countries.map(c => String(c?.iso_3166_1 ?? "").trim().toUpperCase()).filter(Boolean);
	}
	return [];
}

async function resolveFallbackInfo(route, body, request, fetcher, entry) {
	const { title: bodyTitle, year: bodyYear } = extractFallbackInfoFromBody(body, route.mediaType);
	const bodyCountries = extractOriginCountries(body);
	if (bodyTitle) {
		entry.title = bodyTitle;
		entry.year = bodyYear;
		if (bodyCountries.length > 0) entry.originCountries = bodyCountries;
		return { title: bodyTitle, year: bodyYear, originCountries: bodyCountries };
	}
	if (entry.title && entry.year) return { title: entry.title, year: entry.year, originCountries: entry.originCountries ?? [] };
	const language = getRequestLanguage(new URL(request.url));
	const detailResponse = await fetcher(createMediaDetailRequest(request, route.mediaType, route.mediaId, language)).catch(() => undefined);
	let title = "";
	let year = "";
	let originCountries = [];
	if (detailResponse?.ok || (detailResponse?.status >= 200 && detailResponse?.status < 300)) {
		try {
			const payload = JSON.parse(detailResponse.body ?? "{}");
			const info = extractFallbackInfoFromBody(payload, route.mediaType);
			title = info.title;
			year = info.year;
			originCountries = extractOriginCountries(payload);
		} catch {
			// ignore parse error
		}
	}
	entry.title = title;
	entry.year = year;
	if (originCountries.length > 0) entry.originCountries = originCountries;
	return { title, year, originCountries };
}

async function resolveDoubanIds(mediaType, imdbId, fetcher, entry, fallbackTitle, fallbackYear) {
	if (entry.doubanId !== undefined) {
		if (!entry.doubanId) return [];
		return [entry.doubanId, ...(entry.seasonDoubanIds ?? [])];
	}
	const targetType = mediaType === "movie" ? "movie" : "tv";
	const imdbSearch = searchDoubanSubject(imdbId, targetType, fetcher, undefined, false);
	const fallbackSearch = fallbackTitle ? searchDoubanSubject(fallbackTitle, targetType, fetcher, fallbackYear) : Promise.resolve(null);
	const [imdbSubject, fallbackSubject] = await Promise.all([imdbSearch, fallbackSearch]);
	const subject = imdbSubject ?? fallbackSubject;
	const doubanId = String(subject?.id ?? "").trim();
	if (!doubanId) {
		entry.doubanId = "";
		return [];
	}
	let seasonDoubanIds = [];
	if (mediaType === "tv") {
		const seasonsPayload = await fetchDoubanSeasons(doubanId, fetcher);
		seasonDoubanIds = (seasonsPayload?.seasons ?? [])
			.map(season => String(season?.id ?? "").trim())
			.filter(id => id && id !== doubanId);
	}
	entry.doubanId = doubanId;
	entry.seasonDoubanIds = seasonDoubanIds;
	return [doubanId, ...seasonDoubanIds];
}

async function collectDoubanCredits(doubanIds, fetcher, entry) {
	if (entry.characters !== undefined) return entry.characters;
	let credits = {};
	for (const doubanId of doubanIds) {
		const payload = await fetchDoubanCreditsStats(doubanId, fetcher);
		if (!payload) continue;
		credits = mergeDoubanCredits(credits, normalizeDoubanCreditsPayload(payload));
	}
	entry.characters = credits;
	return credits;
}

const PLACEHOLDER_CHARACTERS = new Set(["演员", "配音"]);

// 将豆瓣演员名归一化为简体中文，与 TMDB 演员名（已转简体）匹配。
// Normalizes Douban actor names to Simplified Chinese to match TMDB actor names (already converted to zh-cn).
function normalizeDoubanCreditsKeys(doubanCredits) {
	const normalized = {};
	for (const [name, characters] of Object.entries(doubanCredits ?? {})) {
		const normalizedName = convertChinese(String(name ?? "").trim(), "zh-cn");
		if (!normalizedName) continue;
		const existing = normalized[normalizedName] ?? [];
		normalized[normalizedName] = existing.concat(characters).filter((character, index, array) => array.indexOf(character) === index);
	}
	return normalized;
}

function applyCharacterTranslations(cast, doubanCredits, language) {
	const normalizedCredits = normalizeDoubanCreditsKeys(doubanCredits);
	for (const item of cast) {
		if (!item || typeof item !== "object") continue;
		const currentCharacter = String(item.character ?? "").trim();
		if (currentCharacter && hasHan(currentCharacter)) continue;
		const actorName = convertChinese(String(item.name ?? "").trim(), "zh-cn");
		if (!actorName) continue;
		const characters = normalizedCredits[actorName];
		if (!Array.isArray(characters) || characters.length === 0) continue;
		const translated = characters
			.map(character => convertChinese(character, language))
			.filter(character => character && hasHan(character));
		if (translated.length === 0) continue;
		// 有真角色名时移除占位符（"演员"/"配音"）
		// Remove placeholders ("演员"/"配音") when real character names exist
		const realCharacters = translated.filter(character => !PLACEHOLDER_CHARACTERS.has(character));
		const finalCharacters = realCharacters.length > 0 ? realCharacters : translated;
		// 有现有角色名（如英文）时，占位符不覆盖
		// Don't override existing character name (e.g. English) with placeholder
		const isPlaceholderOnly = finalCharacters.every(character => PLACEHOLDER_CHARACTERS.has(character));
		if (isPlaceholderOnly && currentCharacter) continue;
		item.character = finalCharacters.join(" / ");
	}
}

export async function applyCharacterTranslation(request, body, options = {}) {
	if (!options.characterTranslation) return body;
	const route = parseTmdbRoute(request.url);
	if (!route || !["movie", "tv"].includes(route.mediaType)) return body;
	const credits = body?.credits ?? (Array.isArray(body?.cast) ? body : null);
	if (!credits || !Array.isArray(credits.cast) || credits.cast.length === 0) return body;
	const language = getRequestLanguage(new URL(request.url));
	if (!isChineseLanguage(language)) return body;
	const fetcher = options.fetcher;
	const cacheStore = options.cacheStore;
	if (typeof fetcher !== "function" || !cacheStore) return body;
	const entry = (await cacheStore.getWithFields(route.mediaType, route.mediaId, ["imdbId", "doubanId", "characters", "originCountries"], options.now)) ?? {};
	try {
		const imdbId = await resolveImdbId(route, body, request, fetcher, entry);
		if (!imdbId) {
			const ttl = CACHE_NEGATIVE_TTL_MS;
			await fireCacheWrite(cacheStore.set(route.mediaType, route.mediaId, entry, ttl, options.now), options.waitUntil);
			return body;
		}
		const { title: fallbackTitle, year: fallbackYear, originCountries } = await resolveFallbackInfo(route, body, request, fetcher, entry);
		// 仅对中日韩影片（含港澳台）汉化角色名，非 CJK 影片跳过。
		// Only translate characters for CJK productions (including HK, MO, TW); skip non-CJK.
		if (!isCjkProduction(originCountries)) {
			const ttl = CACHE_NEGATIVE_TTL_MS;
			await fireCacheWrite(cacheStore.set(route.mediaType, route.mediaId, entry, ttl, options.now), options.waitUntil);
			return body;
		}
		const doubanIds = await resolveDoubanIds(route.mediaType, imdbId, fetcher, entry, fallbackTitle, fallbackYear);
		if (doubanIds.length === 0) {
			const ttl = CACHE_NEGATIVE_TTL_MS;
			await fireCacheWrite(cacheStore.set(route.mediaType, route.mediaId, entry, ttl, options.now), options.waitUntil);
			return body;
		}
		const doubanCredits = await collectDoubanCredits(doubanIds, fetcher, entry);
		const ttl = Object.keys(doubanCredits).length > 0 ? CACHE_TTL_MS : CACHE_NEGATIVE_TTL_MS;
		await fireCacheWrite(cacheStore.set(route.mediaType, route.mediaId, entry, ttl, options.now), options.waitUntil);
		if (Object.keys(doubanCredits).length > 0) applyCharacterTranslations(credits.cast, doubanCredits, language);
	} catch (error) {
		console.error("Character translation failed:", error);
	}
	return body;
}
