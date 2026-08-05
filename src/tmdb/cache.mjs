const CACHE_KEY = "dj_tmdb_proxy_cache";
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_FULL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 512 * 1024;

function createEmptyCache() {
	return { version: CACHE_VERSION, stores: { movie: {}, tv: {} } };
}

function isRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value);
}

function isValidEntry(entry) {
	if (!isRecord(entry) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt)) return false;
	return isRecord(entry.aliases) || typeof entry.imdbId === "string" || typeof entry.doubanId === "string" || isRecord(entry.characters) || typeof entry.title === "string" || typeof entry.year === "string" || Array.isArray(entry.originCountries);
}

function normalizeAliases(aliases) {
	return Object.fromEntries(Object.entries(isRecord(aliases) ? aliases : {}).filter(([region, alias]) => ["CN", "SG", "TW", "HK"].includes(region) && typeof alias === "string" && alias.length > 0));
}

function normalizeCharacters(characters) {
	const result = {};
	for (const [name, roles] of Object.entries(isRecord(characters) ? characters : {})) {
		if (typeof name !== "string" || !name) continue;
		const roleList = Array.isArray(roles) ? roles.filter(role => typeof role === "string" && role) : [];
		if (roleList.length > 0) result[name] = roleList;
	}
	return result;
}

function normalizeCache(value) {
	if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.stores)) return createEmptyCache();
	const cache = { version: CACHE_VERSION, stores: { movie: {}, tv: {} } };
	for (const mediaType of ["movie", "tv"]) {
		for (const [id, entry] of Object.entries(isRecord(value.stores[mediaType]) ? value.stores[mediaType] : {})) {
			if (!/^\d+$/.test(id) || !isValidEntry(entry)) continue;
			const normalized = { createdAt: entry.createdAt, expiresAt: entry.expiresAt };
			if (isRecord(entry.aliases)) normalized.aliases = normalizeAliases(entry.aliases);
			if (typeof entry.imdbId === "string" && entry.imdbId) normalized.imdbId = entry.imdbId;
			if (typeof entry.doubanId === "string" && entry.doubanId) normalized.doubanId = entry.doubanId;
			if (Array.isArray(entry.seasonDoubanIds)) normalized.seasonDoubanIds = entry.seasonDoubanIds.filter(item => typeof item === "string" && item);
			if (isRecord(entry.characters)) normalized.characters = normalizeCharacters(entry.characters);
			if (Array.isArray(entry.originCountries)) normalized.originCountries = entry.originCountries.filter(item => typeof item === "string" && item);
			if (typeof entry.title === "string" && entry.title) normalized.title = entry.title;
			if (typeof entry.year === "string" && entry.year) normalized.year = entry.year;
			cache.stores[mediaType][id] = normalized;
		}
	}
	return cache;
}

function readCache(storage) {
	try {
		return normalizeCache(storage?.getItem?.(CACHE_KEY, createEmptyCache()));
	} catch {
		return createEmptyCache();
	}
}

function cacheByteSize(cache) {
	const json = JSON.stringify(cache);
	if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
	return json.length;
}

function pruneCache(cache, now = Date.now()) {
	const entries = [];
	for (const mediaType of ["movie", "tv"]) {
		for (const [id, entry] of Object.entries(cache.stores[mediaType])) {
			if (entry.expiresAt <= now) {
				delete cache.stores[mediaType][id];
				continue;
			}
			entries.push({ mediaType, id, createdAt: entry.createdAt });
		}
	}
	if (cacheByteSize(cache) <= CACHE_MAX_BYTES) return cache;
	entries.sort((a, b) => a.createdAt - b.createdAt);
	for (const entry of entries) {
		delete cache.stores[entry.mediaType][entry.id];
		if (cacheByteSize(cache) <= CACHE_MAX_BYTES) break;
	}
	return cache;
}

function getCacheEntry(cache, mediaType, id, now = Date.now()) {
	const entry = cache.stores[mediaType]?.[String(id)];
	if (!entry || entry.expiresAt <= now) return undefined;
	return entry;
}

function writeCache(storage, cache, now = Date.now()) {
	pruneCache(cache, now);
	try {
		return Boolean(storage?.setItem?.(CACHE_KEY, cache));
	} catch {
		return false;
	}
}

function setCacheEntry(cache, mediaType, id, aliases, now = Date.now(), ttl = CACHE_TTL_MS) {
	return updateCacheEntry(cache, mediaType, id, { aliases: { ...aliases } }, now, ttl);
}

function updateCacheEntry(cache, mediaType, id, data, now = Date.now(), ttl = CACHE_TTL_MS) {
	if (!isRecord(cache.stores[mediaType])) cache.stores[mediaType] = {};
	const store = cache.stores[mediaType];
	const oldEntry = store[String(id)];
	const valid = isValidEntry(oldEntry);
	store[String(id)] = {
		...(valid ? oldEntry : {}),
		...data,
		createdAt: valid ? oldEntry.createdAt : now,
		expiresAt: now + ttl,
	};
	return cache;
}

function getCacheField(cache, mediaType, id, fieldName, now = Date.now()) {
	const entry = getCacheEntry(cache, mediaType, id, now);
	return entry?.[fieldName];
}

export { CACHE_KEY, CACHE_MAX_BYTES, CACHE_NEGATIVE_TTL_MS, CACHE_FULL_TTL_MS, CACHE_TTL_MS, CACHE_VERSION, createEmptyCache, getCacheEntry, getCacheField, isValidEntry, normalizeCache, pruneCache, readCache, setCacheEntry, updateCacheEntry, writeCache };
