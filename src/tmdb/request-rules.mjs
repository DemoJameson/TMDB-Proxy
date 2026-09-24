import { createTmdbApiKeyProvider } from "./api-key.mjs";
import { resolveProxyConfig } from "./config.mjs";
import { STATE_HEADER, setHeader } from "./headers.mjs";
import { appendToResponse, getRequestLanguage, isChineseLanguage, isForwardHost, isTmdbCompatiblePath, isTmdbImageHost, parseTmdbRoute, rewriteAppendToResponse, rewriteForwardToTmdbUrl, rewriteToTvAggregateCredits, rewriteToTvSeasonAggregateCredits } from "./routes.mjs";

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
	const apiKeyProvider = options.apiKeyProvider ?? createTmdbApiKeyProvider({ env: options.env, backendUrl: config.cacheBackend, storage: options.storage, now: options.now });
	// 仅在需要注入 key 时解析：脚本端首次使用可能要向后端拉取，避免对已有凭证的请求发起无谓请求。
	// Resolve the key only when injection is needed: script runtimes may fetch it remotely, so skip requests that already carry credentials.
	const needsApiKey = (isTmdbCompatiblePath(url) && !url.searchParams.get("api_key") && !hasAuthorization) || isForwardHost(url.hostname);
	const apiKey = needsApiKey ? await apiKeyProvider.get() : undefined;
	if (apiKey && isTmdbCompatiblePath(url) && !url.searchParams.get("api_key") && !hasAuthorization) url.searchParams.set("api_key", apiKey);
	if (isForwardHost(url.hostname)) {
		const tmdbUrl = new URL(url.toString());
		rewriteForwardToTmdbUrl(tmdbUrl, { keepSearch: true });
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
			if (!tmdbUrl.searchParams.get("api_key") && apiKey) tmdbUrl.searchParams.set("api_key", apiKey);
			return { $request: request, $response: { status: 302, headers: { Location: tmdbUrl.toString() } }, state, config };
		}
		request.url = url.toString();
		return { $request: request, state, config };
	}
	if (!route) {
		if (config.imageWebp && isTmdbImageHost(url.hostname)) {
			request.headers ??= {};
			setHeader(request.headers, "Accept", "image/webp,*/*");
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

export { applyTmdbRequestRules, encodeState, fetchTmdbWithNativeFetch, fetchUpstream, STATE_HEADER };
