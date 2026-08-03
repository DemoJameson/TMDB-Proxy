import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argumentFields, BOXJS_CONFIG_KEY, boxjs, metadata, mitmHosts, scriptRules } from "../src/module-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const scriptBaseUrl = `${metadata.rawBaseUrl}/${metadata.modulePath}`;

function getRuleTargets(rule) {
	return Array.isArray(rule.targets) && rule.targets.length > 0 ? rule.targets : ["plugin", "sgmodule", "snippet"];
}

function formatDefaultValue(value) {
	return typeof value === "boolean" ? String(value) : String(value ?? "");
}

function inferArgumentType(fieldType) {
	if (fieldType === "boolean") return "switch";
	if (fieldType === "text") return "input";
	if (fieldType === "select") return "select";
	throw new Error(`Unsupported argument type: ${fieldType}`);
}

function inferBoxjsSettingType(fieldType) {
	if (fieldType === "boolean" || fieldType === "text" || fieldType === "select") return fieldType;
	throw new Error(`Unsupported BoxJs setting type: ${fieldType}`);
}

function renderPluginArgumentLine(field) {
	return `${field.key} = ${inferArgumentType(field.type)}, "${formatDefaultValue(field.defaultValue)}", tag=${field.tag}, desc=${field.desc}`;
}

function buildScriptUrl(scriptFile) {
	return `${scriptBaseUrl}/${scriptFile}`;
}

function buildArgumentList(argumentKeys, formatter) {
	return argumentKeys.map(formatter).join(",");
}

function normalizePatternHost(hostPattern) {
	return String(hostPattern ?? "")
		.replace(/\\\./g, ".")
		.replace(/\\-/g, "-");
}

function expandHostExpression(expression) {
	let expressions = [String(expression ?? "")];
	let changed = true;
	while (changed) {
		changed = false;
		const next = [];
		for (const expr of expressions) {
			const match = expr.match(/\(\?:([^()]+)\)/);
			if (match) {
				changed = true;
				const index = expr.indexOf(match[0]);
				const prefix = expr.slice(0, index);
				const suffix = expr.slice(index + match[0].length);
				for (const option of match[1].split("|")) next.push(prefix + option + suffix);
			} else {
				next.push(expr);
			}
		}
		expressions = next;
	}
	return [...new Set(expressions.map(normalizePatternHost))];
}

function extractHostsFromPattern(pattern) {
	const match = String(pattern ?? "").match(/^\^https:\\\/\\\/(.+?)\\\//);
	if (!match) return [];
	return expandHostExpression(match[1]);
}

function assertManifestIsValid() {
	const argumentKeySet = new Set(argumentFields.map(field => field.key));
	const mitmHostSet = new Set(mitmHosts);
	for (const rule of scriptRules) {
		for (const key of rule.argumentKeys ?? []) {
			if (!argumentKeySet.has(key)) throw new Error(`Unknown argument key "${key}" in "${rule.title}"`);
		}
		for (const host of extractHostsFromPattern(rule.pattern)) {
			if (!mitmHostSet.has(host)) throw new Error(`MITM host "${host}" is missing for "${rule.title}"`);
		}
	}
}

function renderPlugin() {
	const lines = [`#!name=${metadata.name}`, `#!desc=${metadata.description}`, `#!icon=${metadata.icon}`, `#!homepage=${metadata.homepage}`, `#!author=${metadata.author}`, "", "[Argument]"];
	for (const field of argumentFields) lines.push(renderPluginArgumentLine(field));
	lines.push("", "[Script]");
	for (const rule of scriptRules.filter(rule => getRuleTargets(rule).includes("plugin"))) {
		const parts = [`${rule.phase} ${rule.pattern} script-path=${buildScriptUrl(rule.scriptFile)}`];
		if (rule.requiresBody) parts.push("requires-body=true");
		parts.push(`timeout=${rule.timeout}`);
		if (rule.argumentKeys?.length) parts.push(`argument=[${buildArgumentList(rule.argumentKeys, key => `{${key}}`)}]`);
		parts.push(`tag=${rule.title}`);
		lines.push(`# ${rule.comment}`, parts.join(", "));
	}
	lines.push("", "[MITM]", `hostname = ${mitmHosts.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

function renderSgmodule() {
	const argumentPairs = argumentFields.map(field => `${field.key}:"${formatDefaultValue(field.defaultValue)}"`).join(", ");
	const argumentDescriptions = argumentFields.map(field => `${field.key}: ${field.desc}`).join("\\n");
	const lines = [`#!name=${metadata.name}`, `#!desc=${metadata.description}`, `#!icon=${metadata.icon}`, `#!homepage=${metadata.homepage}`, `#!author=${metadata.author}`, `#!arguments=${argumentPairs}`, `#!arguments-desc=${argumentDescriptions}`, "", "[Script]"];
	for (const rule of scriptRules.filter(rule => getRuleTargets(rule).includes("sgmodule"))) {
		const parts = [`${rule.title} = type=${rule.phase}`, `pattern=${rule.pattern}`];
		if (rule.requiresBody) parts.push("requires-body=true");
		if (Number.isFinite(Number(rule.maxSize))) parts.push(`max-size=${rule.maxSize}`);
		parts.push(`timeout=${rule.timeout}`);
		if (rule.argumentKeys?.length) parts.push(`argument=${buildArgumentList(rule.argumentKeys, key => `{{{${key}}}}`)}`);
		parts.push(`script-path=${buildScriptUrl(rule.scriptFile)}`);
		lines.push(`# ${rule.comment}`, parts.join(", "));
	}
	lines.push("", "[MITM]", `hostname = %APPEND% ${mitmHosts.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

function renderSnippet() {
	const lines = [`#!name=${metadata.name}`, `#!desc=${metadata.description}`, `#!icon=${metadata.icon}`, `#!homepage=${metadata.homepage}`, `#!author=${metadata.author}`, "", "# [rewrite_remote]"];
	for (const rule of scriptRules.filter(rule => getRuleTargets(rule).includes("snippet"))) {
		const snippetType = rule.phase === "http-request" ? "script-request-header" : "script-response-body";
		lines.push(`# ${rule.comment}`, `${rule.pattern} url ${snippetType} ${buildScriptUrl(rule.scriptFile)}`);
	}
	lines.push("# [mitm]", `hostname = ${mitmHosts.join(", ")}`);
	return `${lines.join("\n")}\n`;
}

function renderBoxjs() {
	const storagePrefix = `@${BOXJS_CONFIG_KEY}`;
	const keys = argumentFields.map(field => `${storagePrefix}.${field.key}`);
	const app = {
		id: boxjs.app.id,
		name: metadata.name,
		keys,
		author: boxjs.app.author,
		repo: boxjs.app.repo,
		icons: boxjs.app.icons,
		settings: argumentFields.map(field => ({
			id: `${storagePrefix}.${field.key}`,
			name: field.tag,
			val: field.defaultValue,
			type: inferBoxjsSettingType(field.type),
			desc: field.desc,
		})),
		descs_html: boxjs.app.descsHtml,
	};
	const { app: _appTemplate, ...subscription } = boxjs;
	return `${JSON.stringify({ ...subscription, apps: [app] }, null, 4)}\n`;
}

function renderGeneratedTargets() {
	assertManifestIsValid();
	return [
		{ outputFile: "dist/tmdb_proxy.plugin", content: renderPlugin() },
		{ outputFile: "dist/tmdb_proxy.sgmodule", content: renderSgmodule() },
		{ outputFile: "dist/tmdb_proxy.snippet", content: renderSnippet() },
		{ outputFile: "dist/boxjs.json", content: renderBoxjs() },
	];
}

async function writeGeneratedTargets() {
	for (const target of renderGeneratedTargets()) {
		const outputPath = path.join(rootDir, target.outputFile);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, target.content, "utf8");
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	writeGeneratedTargets().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}

export { renderBoxjs, renderGeneratedTargets, renderPlugin, renderSgmodule, renderSnippet };
