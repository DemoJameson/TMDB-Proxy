import { applyTmdbRequestRules } from "../tmdb/request-rules.mjs";

async function Request($request, options = {}) {
	const { $request: processedRequest, $response } = await applyTmdbRequestRules($request, options);
	return { $request: processedRequest, $response };
}

export { Request };
