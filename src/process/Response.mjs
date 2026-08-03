import { applyTmdbResponseRules } from "../tmdb/proxy.mjs";

async function Response($request, $response, options = {}) {
	return await applyTmdbResponseRules($request, $response, options);
}

export { Response };
