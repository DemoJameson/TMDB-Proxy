const TMDB_HOSTS = new Set(["api.themoviedb.org", "api.tmdb.org", "vidora-tmdb.wwmm.date"]);

const TMDB_IMAGE_HOSTS = new Set(["image.tmdb.org"]);

const FORWARD_HOSTS = new Set(["forwardinfo.vvebo.vip"]);

function isForwardHost(hostname) {
	return FORWARD_HOSTS.has(String(hostname).toLowerCase());
}

function isTmdbHost(hostname) {
	return TMDB_HOSTS.has(String(hostname).toLowerCase());
}

function isTmdbImageHost(hostname) {
	return TMDB_IMAGE_HOSTS.has(String(hostname).toLowerCase());
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

function isChineseLanguage(language) {
	return ["zh", "zh-cn", "zh-sg", "zh-tw", "zh-hk"].includes(String(language ?? "").toLowerCase());
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

export { appendToResponse, buildAlternativeTitlesUrl, buildExternalIdsUrl, buildMediaDetailUrl, buildTvDetailUrl, FORWARD_HOSTS, getRequestLanguage, isChineseLanguage, isForwardHost, isTmdbCompatiblePath, isTmdbHost, isTmdbImageHost, parseTmdbRoute, rewriteAppendToResponse, rewriteToTvAggregateCredits, rewriteToTvSeasonAggregateCredits, TMDB_HOSTS, TMDB_IMAGE_HOSTS };
