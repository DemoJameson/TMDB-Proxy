import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderGeneratedTargets } from "../scripts/build-modules.mjs";
import { argumentFields, BOXJS_CONFIG_KEY, mitmHosts } from "../src/module-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function normalize(value) {
	return String(value).replace(/\r\n/g, "\n");
}

test("manifest 生成的代理工具与 BoxJs 文件保持一致", async () => {
	for (const target of renderGeneratedTargets()) {
		const actual = await readFile(path.join(rootDir, target.outputFile), "utf8");
		assert.equal(normalize(actual), normalize(target.content), `${target.outputFile} should be generated from manifest`);
	}
});

test("BoxJs keys 与参数字段一致", () => {
	const boxjsTarget = renderGeneratedTargets().find(target => target.outputFile === "dist/boxjs.json");
	const payload = JSON.parse(boxjsTarget.content);
	const app = payload.apps[0];
	const expectedKeys = argumentFields.map(field => `@${BOXJS_CONFIG_KEY}.${field.key}`);
	assert.deepEqual(app.keys, expectedKeys);
	assert.deepEqual(
		app.settings.map(setting => setting.id),
		expectedKeys,
	);
	assert.deepEqual(
		app.settings.map(setting => setting.val),
		argumentFields.map(field => field.defaultValue),
	);
});

test("订阅产物包含目标平台语法、脚本路径和 MITM 域名", () => {
	const generated = Object.fromEntries(renderGeneratedTargets().map(target => [target.outputFile, target.content]));
	assert.match(generated["dist/tmdb_proxy.plugin"], /http-request .*tmdb_proxy_request\.js/);
	assert.match(generated["dist/tmdb_proxy.plugin"], /http-response .*tmdb_proxy_response\.js/);
	assert.match(generated["dist/tmdb_proxy.plugin"], /http-response .*vidora-tmdb\\\.wwmm\\\.date.*tmdb_proxy_response\.js/);
	assert.match(generated["dist/tmdb_proxy.sgmodule"], /argument=\{\{\{aliasFallback\}\}\},\{\{\{characterTranslation\}\}\}/);
	assert.match(generated["dist/tmdb_proxy.snippet"], /script-request-header .*tmdb_proxy_request\.js/);
	assert.match(generated["dist/tmdb_proxy.snippet"], /script-response-body .*tmdb_proxy_response\.js/);
	assert.match(generated["dist/tmdb_proxy.plugin"], /forwardinfo\\\.vvebo\\\.vip/);
	for (const host of mitmHosts) {
		assert.ok(generated["dist/tmdb_proxy.plugin"].includes(host));
		assert.ok(generated["dist/tmdb_proxy.sgmodule"].includes(host));
		assert.ok(generated["dist/tmdb_proxy.snippet"].includes(host));
	}
});
