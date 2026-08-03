import { applyTmdbRequestRules } from "../tmdb/request-rules.mjs";

async function Request($request) {
	const { $request: processedRequest, $response } = await applyTmdbRequestRules($request);
	return { $request: processedRequest, $response };
}

export { Request };
