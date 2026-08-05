import { resolveProxyConfig } from "./config.mjs";
import { appendToResponse, getRequestLanguage, isChineseLanguage, isForwardHost, isTmdbCompatiblePath, isTmdbImageHost, parseTmdbRoute, rewriteAppendToResponse, rewriteToTvAggregateCredits, rewriteToTvSeasonAggregateCredits } from "./routes.mjs";

const STATE_HEADER = "x-tmdb-proxy-state";
const DEFAULT_TMDB_API_KEY = "ebb2c093078553178d5d75c6d86d7bde";

// 获取 TMDB API Key：优先环境变量 TMDB_API_KEY，回退到硬编码默认值。
// Get TMDB API Key: prefer TMDB_API_KEY env var, fall back to hardcoded default.
function getTmdbApiKey(env) {
	const envKey = env?.TMDB_API_KEY ?? globalThis.process?.env?.TMDB_API_KEY;
	return typeof envKey === "string" && envKey ? envKey : DEFAULT_TMDB_API_KEY;
}

function setRequestHeader(request, name, value) {
	request.headers ??= {};
	const lower = name.toLowerCase();
	for (const key of Object.keys(request.headers)) {
		if (key.toLowerCase() === lower) delete request.headers[key];
	}
	request.headers[name] = value;
}

function encodeState(state) {
	return encodeURIComponent(JSON.stringify(state));
}

async function fetchUpstream(request) {
	const { url, bodyBytes, timeout: _timeout, policy: _policy, opts: _opts, redirection: _redirection, "auto-redirect": _autoRedirect, "auto-cookie": _autoCookie, ...init } = request;
	if (bodyBytes !== undefined && init.body === undefined) init.body = bodyBytes;
	init.headers = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([key]) => key.toLowerCase() !== STATE_HEADER));
	const response = await globalThis.fetch(url, init);
	const bodyBytesResult = await response.arrayBuffer();
	return {
		ok: response.ok,
		status: response.status,
		statusCode: response.status,
		statusText: response.statusText,
		body: new TextDecoder().decode(bodyBytesResult),
		bodyBytes: bodyBytesResult,
		headers: Object.fromEntries(response.headers.entries()),
	};
}

async function fetchTmdbWithNativeFetch(request) {
	const response = await fetchUpstream(request);
	return { ok: response.ok, status: response.status, body: response.body };
}

async function applyTmdbRequestRules(request, options = {}) {
	const url = new URL(request.url);
	const config = resolveProxyConfig({ argument: options.argument, env: options.env, url });
	const route = parseTmdbRoute(url);
	const state = { hadClientAlternativeTitles: false, hadClientTranslations: false, hadClientExternalIds: false, aggregateCreditsRewrite: false, appendCreditsRewrite: false, hadClientAggregateCreditsAppend: false };
	const hasAuthorization = Object.keys(request.headers ?? {}).some(key => key.toLowerCase() === "authorization");
	const apiKey = getTmdbApiKey(options.env);
	if (isTmdbCompatiblePath(url) && !url.searchParams.get("api_key") && !hasAuthorization) url.searchParams.set("api_key", apiKey);
	if (isForwardHost(url.hostname)) {
		const tmdbUrl = new URL(url.toString());
		tmdbUrl.host = "api.tmdb.org";
		tmdbUrl.pathname = "/3" + url.pathname;
		const forwardRoute = parseTmdbRoute(tmdbUrl);
		let needsRedirect = false;
		if (forwardRoute?.isDetail && isChineseLanguage(getRequestLanguage(url)) && (config.aliasFallback || (config.characterTranslation && !forwardRoute.isCollectionDetail))) needsRedirect = true;
		if (forwardRoute?.mediaType === "tv" && config.aggregateCredits) {
			if (forwardRoute.isTvCredits || forwardRoute.isTvSeasonCredits) {
				needsRedirect = true;
			} else {
				const appendItems = String(url.searchParams.get("append_to_response") ?? "")
					.split(",")
					.map(item => item.trim())
					.filter(Boolean);
				if (appendItems.includes("credits")) needsRedirect = true;
			}
		}
		if (needsRedirect) {
			if (!tmdbUrl.searchParams.get("api_key")) tmdbUrl.searchParams.set("api_key", apiKey);
			return { $request: request, $response: { status: 302, headers: { Location: tmdbUrl.toString() } }, state, config };
		}
		request.url = url.toString();
		return { $request: request, state, config };
	}
	if (!route) {
		if (config.imageWebp && isTmdbImageHost(url.hostname)) {
			setRequestHeader(request, "Accept", "image/webp,*/*");
		}
		request.url = url.toString();
		return { $request: request, state, config };
	}

	if (route.isDetail && (config.aliasFallback || config.characterTranslation) && isChineseLanguage(getRequestLanguage(url))) {
		if (route.isCollectionDetail) {
			if (config.aliasFallback) {
				const result = appendToResponse(url, "translations");
				state.hadClientTranslations = result.hadValue;
			}
		} else {
			const altResult = appendToResponse(url, "alternative_titles");
			state.hadClientAlternativeTitles = altResult.hadValue;
			const extResult = appendToResponse(url, "external_ids");
			state.hadClientExternalIds = extResult.hadValue;
		}
	}

	if (route.mediaType === "tv" && config.aggregateCredits) {
		const result = rewriteAppendToResponse(url, "credits", "aggregate_credits");
		state.appendCreditsRewrite = result.rewrote;
		state.hadClientAggregateCreditsAppend = result.hadTarget;
	}

	if ((route.isTvSeasonCredits || route.isTvCredits) && config.aggregateCredits) {
		if (route.isTvSeasonCredits) rewriteToTvSeasonAggregateCredits(url, route.seasonNumber);
		else rewriteToTvAggregateCredits(url);
		state.aggregateCreditsRewrite = true;
	}

	request.url = url.toString();
	request.headers ??= {};
	if (state.hadClientAlternativeTitles || state.hadClientTranslations || state.hadClientExternalIds || state.aggregateCreditsRewrite || state.appendCreditsRewrite || (route.isDetail && (config.aliasFallback || config.characterTranslation))) request.headers[STATE_HEADER] = encodeState(state);
	return { $request: request, state, config };
}

export { applyTmdbRequestRules, DEFAULT_TMDB_API_KEY, encodeState, fetchTmdbWithNativeFetch, fetchUpstream, getTmdbApiKey, STATE_HEADER };
