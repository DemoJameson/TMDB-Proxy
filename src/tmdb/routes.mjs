// TMDB 反代主机（Cloudflare 单域名）：API 走 /3/...、图片走 /t/p/...，由反代端按路径分流。
const TMDB_PROXY_HOST = "tmdb.demojameson.de5.net";

const TMDB_HOSTS = new Set(["api.themoviedb.org", "api.tmdb.org", "vidora-tmdb.wwmm.date", TMDB_PROXY_HOST]);

const TMDB_IMAGE_HOSTS = new Set(["image.tmdb.org", TMDB_PROXY_HOST]);

const TMDB_API_ORIGIN_HOSTS = new Set(["api.themoviedb.org", "api.tmdb.org"]);

const TMDB_IMAGE_ORIGIN_HOSTS = new Set(["image.tmdb.org"]);

const FORWARD_HOSTS = new Set(["forwardinfo.vvebo.vip"]);

const HAN_REGEX = /[\u3400-\u9fff]/;

function isForwardHost(hostname) {
	return FORWARD_HOSTS.has(String(hostname).toLowerCase());
}

function isTmdbHost(hostname) {
	return TMDB_HOSTS.has(String(hostname).toLowerCase());
}

function isTmdbImageHost(hostname) {
	return TMDB_IMAGE_HOSTS.has(String(hostname).toLowerCase());
}

// TMDB 图片路径统一为 /t/p/{size}/{file}。
const TMDB_IMAGE_PATH_PREFIX = "/t/p/";

// 是否为图片请求：图片域名 + /t/p/... 路径。反代域名同时承载 API 与图片，
// 只判断域名会把 /3/movie/popular 这类没有解析成 route 的 API 路径误判为图片并注入图片请求头。
function isTmdbImageRequest(input) {
	const url = input instanceof URL ? input : new URL(input);
	return isTmdbImageHost(url.hostname) && url.pathname.startsWith(TMDB_IMAGE_PATH_PREFIX);
}

// 源域名：用于判断是否需要重定向到自建反代域名（反代域名本身不属于源域名，避免死循环）。
function isTmdbApiOriginHost(hostname) {
	return TMDB_API_ORIGIN_HOSTS.has(String(hostname).toLowerCase());
}

function isTmdbImageOriginHost(hostname) {
	return TMDB_IMAGE_ORIGIN_HOSTS.has(String(hostname).toLowerCase());
}

function parseTmdbRoute(input) {
	const url = input instanceof URL ? input : new URL(input);
	const parts = url.pathname.split("/").filter(Boolean);
	const isForward = isForwardHost(url.hostname);
	if (!isTmdbHost(url.hostname) && !isForward) return null;
	if (!isForward && parts[0] !== "3") return null;
	const routeParts = isForward ? parts : parts.slice(1);
	const [mediaType, mediaId, segment, seasonNumber, endpoint] = routeParts;
	if (!["movie", "tv", "collection"].includes(mediaType) || !/^\d+$/.test(mediaId ?? "")) return null;
	const route = {
		url,
		parts,
		routeParts,
		mediaType,
		mediaId,
		isMovieDetail: mediaType === "movie" && routeParts.length === 2,
		isTvDetail: mediaType === "tv" && routeParts.length === 2,
		isCollectionDetail: mediaType === "collection" && routeParts.length === 2,
		isAlternativeTitles: ["movie", "tv"].includes(mediaType) && routeParts.length === 3 && segment === "alternative_titles",
		isMovieCredits: mediaType === "movie" && routeParts.length === 3 && segment === "credits",
		isTvCredits: mediaType === "tv" && routeParts.length === 3 && segment === "credits",
		isTvAggregateCredits: mediaType === "tv" && routeParts.length === 3 && segment === "aggregate_credits",
		isTvSeasonCredits: mediaType === "tv" && routeParts.length === 5 && segment === "season" && /^\d+$/.test(seasonNumber ?? "") && endpoint === "credits",
		isTvSeasonAggregateCredits: mediaType === "tv" && routeParts.length === 5 && segment === "season" && /^\d+$/.test(seasonNumber ?? "") && endpoint === "aggregate_credits",
		seasonNumber,
	};
	route.isDetail = route.isMovieDetail || route.isTvDetail || route.isCollectionDetail;
	return route;
}

function isTmdbCompatiblePath(input) {
	const url = input instanceof URL ? input : new URL(input);
	return isTmdbHost(url.hostname) && url.pathname.split("/").filter(Boolean)[0] === "3";
}

// 将 forwardinfo 请求 URL 原地改写为 TMDB API URL（替换主机并补 /3 前缀）；keepSearch 为 false 时清空查询参数。
// 返回 URL 是否来自 forward 主机。
function rewriteForwardToTmdbUrl(url, { keepSearch = false } = {}) {
	if (!isForwardHost(url.hostname)) return false;
	url.host = "api.tmdb.org";
	url.pathname = `/3${url.pathname}`;
	if (!keepSearch) url.search = "";
	return true;
}

function isChineseLanguage(language) {
	const normalized = String(language ?? "").toLowerCase();
	return normalized === "zh" || normalized.startsWith("zh-");
}

// 判断文本是否含汉字，用于识别标题/名称是否已是中文（不涉及简繁转换）。
function hasHan(value) {
	return HAN_REGEX.test(String(value ?? ""));
}

function getRequestLanguage(url) {
	return url.searchParams.get("language") || "";
}

function appendToResponse(url, value) {
	const items = new Set(
		String(url.searchParams.get("append_to_response") ?? "")
			.split(",")
			.map(item => item.trim())
			.filter(Boolean),
	);
	const hadValue = items.has(value);
	items.add(value);
	url.searchParams.set("append_to_response", Array.from(items).join(","));
	return { hadValue };
}

function rewriteAppendToResponse(url, from, to) {
	const items = String(url.searchParams.get("append_to_response") ?? "")
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
	let rewrote = false;
	const rewritten = [];
	for (const item of items) {
		if (item === from) {
			rewrote = true;
			if (!rewritten.includes(to)) rewritten.push(to);
			continue;
		}
		if (!rewritten.includes(item)) rewritten.push(item);
	}
	if (rewrote) url.searchParams.set("append_to_response", rewritten.join(","));
	return { rewrote, hadTarget: items.includes(to) };
}

function rewriteToTvAggregateCredits(url) {
	url.pathname = url.pathname.replace(/\/credits\/?$/, "/aggregate_credits");
}

function rewriteToTvSeasonAggregateCredits(url, seasonNumber) {
	const route = parseTmdbRoute(url);
	url.pathname = `/3/tv/${route?.mediaId}/season/${seasonNumber}/aggregate_credits`;
}

function buildTvDetailUrl(url) {
	const route = parseTmdbRoute(url);
	const detailUrl = new URL(url.toString());
	detailUrl.pathname = `/3/tv/${route.mediaId}`;
	detailUrl.searchParams.delete("append_to_response");
	return detailUrl;
}

function buildAlternativeTitlesUrl(sourceUrl, mediaType, mediaId) {
	const url = new URL(sourceUrl.toString());
	url.pathname = `/3/${mediaType}/${mediaId}/alternative_titles`;
	url.searchParams.delete("append_to_response");
	url.searchParams.delete("language");
	return url;
}

function buildExternalIdsUrl(sourceUrl, mediaType, mediaId) {
	const url = new URL(sourceUrl.toString());
	url.pathname = `/3/${mediaType}/${mediaId}/external_ids`;
	url.searchParams.delete("append_to_response");
	url.searchParams.delete("language");
	return url;
}

function buildMediaDetailUrl(sourceUrl, mediaType, mediaId) {
	const url = new URL(sourceUrl.toString());
	url.pathname = `/3/${mediaType}/${mediaId}`;
	url.searchParams.delete("append_to_response");
	return url;
}

export {
	appendToResponse,
	buildAlternativeTitlesUrl,
	buildExternalIdsUrl,
	buildMediaDetailUrl,
	buildTvDetailUrl,
	FORWARD_HOSTS,
	getRequestLanguage,
	hasHan,
	isChineseLanguage,
	isForwardHost,
	isTmdbApiOriginHost,
	isTmdbCompatiblePath,
	isTmdbHost,
	isTmdbImageHost,
	isTmdbImageOriginHost,
	isTmdbImageRequest,
	parseTmdbRoute,
	rewriteAppendToResponse,
	rewriteForwardToTmdbUrl,
	rewriteToTvAggregateCredits,
	rewriteToTvSeasonAggregateCredits,
	TMDB_HOSTS,
	TMDB_IMAGE_HOSTS,
	TMDB_PROXY_HOST,
};
