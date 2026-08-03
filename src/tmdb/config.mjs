import { argumentFields, BOXJS_CONFIG_KEY } from "../module-manifest.mjs";
import { Storage } from "../runtime/script.mjs";

function createDefaultConfig() {
	return Object.fromEntries(argumentFields.map(field => [field.key, field.defaultValue]));
}

function parseBoolean(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function readBoxJsConfig() {
	try {
		const stored = Storage.getItem(BOXJS_CONFIG_KEY, {});
		return stored && typeof stored === "object" ? stored : {};
	} catch {
		return {};
	}
}

function parseText(value, fallback) {
	if (value === undefined || value === null) return fallback;
	const trimmed = String(value).trim();
	return trimmed === "" ? fallback : trimmed;
}

function applyConfigValues(config, source = {}) {
	for (const field of argumentFields) {
		const value = source[field.key];
		if (value === undefined) continue;
		config[field.key] = field.type === "boolean" ? parseBoolean(value, config[field.key]) : parseText(value, config[field.key]);
	}
	return config;
}

function parseRuntimeArgument(argument) {
	if (!argument) return {};
	if (typeof argument === "object") {
		const entries = Object.entries(argument);
		if (entries.length === 1 && entries[0][1] === "" && entries[0][0].includes(",")) {
			return parseRuntimeArgument(entries[0][0]);
		}
		return argument;
	}
	const raw = String(argument)
		.trim()
		.replace(/^\[|\]$/g, "");
	if (!raw) return {};
	if (raw.includes("=") || raw.includes("&")) {
		return Object.fromEntries(new URLSearchParams(raw));
	}
	const values = raw.split(",").map(value => value.trim());
	return Object.fromEntries(argumentFields.map((field, index) => [field.key, values[index]]));
}

function readEnvironmentConfig(env = {}) {
	const map = {
		aliasFallback: "TMDB_ALIAS_FALLBACK",
		aggregateCredits: "TMDB_AGGREGATE_CREDITS",
		imageWebp: "TMDB_IMAGE_WEBP",
		characterTranslation: "TMDB_CHARACTER_TRANSLATION",
	};
	return Object.fromEntries(Object.entries(map).map(([key, name]) => [key, env[name]]));
}

function readUrlOverrideConfig(url) {
	const config = {};
	for (const field of argumentFields) {
		const key = `proxy.${field.key}`;
		if (url.searchParams.has(key)) {
			config[field.key] = url.searchParams.get(key);
			url.searchParams.delete(key);
		}
	}
	return config;
}

function resolveProxyConfig({ argument = globalThis.$argument, env = globalThis.process?.env, url } = {}) {
	const config = createDefaultConfig();
	applyConfigValues(config, readBoxJsConfig());
	applyConfigValues(config, parseRuntimeArgument(argument));
	if (url) applyConfigValues(config, readUrlOverrideConfig(url));
	applyConfigValues(config, readEnvironmentConfig(env));
	return config;
}

export { argumentFields, BOXJS_CONFIG_KEY, createDefaultConfig, parseBoolean, parseRuntimeArgument, resolveProxyConfig };
