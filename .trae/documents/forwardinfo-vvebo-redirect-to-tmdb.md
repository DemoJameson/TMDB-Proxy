# 支持 Forward 播放器反代请求重定向到 TMDB

> **勘误（2026-09-24）**：本文是实现前的设计记录，其中 `DEFAULT_TMDB_API_KEY` 常量与硬编码 key 已于后续版本移除。现在请求脚本不再内置 API Key，改为「环境变量 `TMDB_API_KEY` → 本地缓存 → 缓存后端 `GET /key`」三级获取（见 `src/tmdb/api-key.mjs` 与 README「反代部署」）。下文片段中的 `DEFAULT_TMDB_API_KEY` 请理解为「当前生效的 API Key」；测试用例现改为传入 `env: { TMDB_API_KEY: … }`。

## 概述

支持处理 Forward 播放器的反代请求（如 `https://forwardinfo.vvebo.vip/tv/272432/season/1/credits?language=zh-CN`）。Forward 请求需要签名，不能直接修改 URL 或参数。**只有需要修改 URL 或参数的 forward 请求才重定向到 TMDB**（在请求脚本中返回 302），让重定向后的请求走已有的 TMDB 处理链路。不需要修改的请求直接放行到 forwardinfo（签名完好，正常工作）。

## 当前状态分析

- `src/tmdb/routes.mjs`：`TMDB_HOSTS = {api.themoviedb.org, api.tmdb.org, vidora-tmdb.wwmm.date}`，`parseTmdbRoute` 要求 host 在 TMDB_HOSTS 且路径以 `/3` 开头。无 forwardinfo 相关代码。
- `src/tmdb/request-rules.mjs`：`applyTmdbRequestRules` 在以下条件修改 URL/参数：
  - `route.isDetail && config.aliasFallback && isChineseLanguage(language)` → 追加 `alternative_titles`/`translations`
  - `route.mediaType === "tv" && config.aggregateCredits && (route.isTvCredits || route.isTvSeasonCredits)` → 改写为 `aggregate_credits`
  - `route.mediaType === "tv" && config.aggregateCredits && append_to_response 包含 "credits"` → 改写为 `aggregate_credits`
- `src/process/Request.mjs`：固定返回 `{ $request, $response: undefined }`。
- `src/request.js`（代理工具入口）：`$response` 为 object 时直接返回响应，为 undefined 时发送修改后的请求。**已有 $response 支持。**
- `src/module-manifest.mjs`：`scriptRules` + `mitmHosts`，`assertManifestIsValid` 校验 pattern 中的 host 都在 mitmHosts 中。

## 设计方案

### 条件重定向流程

```
Forward 播放器 → forwardinfo.vvebo.vip/tv/272432/season/1/credits?language=zh-CN
  ↓ MITM 拦截，请求脚本触发（匹配 forwardinfo pattern）
  ↓ applyTmdbRequestRules 检测到 isForwardHost
  ↓ 构造 TMDB 等价 URL：api.tmdb.org/3/tv/272432/season/1/credits?language=zh-CN
  ↓ parseTmdbRoute 解析路由，检查是否需要修改：
  ↓   ✓ aggregateCredits 开启 + TV season credits → 需要改写为 aggregate_credits
  ↓ 返回 302 → api.tmdb.org/3/tv/272432/season/1/credits?language=zh-CN&api_key=<DEFAULT>
  ↓ Forward 播放器跟随重定向，向 api.tmdb.org 发起新请求
  ↓ MITM 拦截，请求脚本触发（匹配 api.tmdb.org pattern）
  ↓ 已有 TMDB 处理：api_key 已存在、aggregate_credits 改写等
  ↓ 响应脚本触发：中文别名回填
  ↓ 返回最终响应

Forward 播放器 → forwardinfo.vvebo.vip/movie/popular?language=zh-CN
  ↓ 不匹配 forwardinfo pattern（非 detail/credits 路径），脚本不触发
  ↓ 请求直接发送到 forwardinfo.vvebo.vip（签名完好）
```

### 不需要重定向的情况（直接放行）

- 英文详情请求（`aliasFallback` 开启但语言非中文 → 不追加 `alternative_titles`）
- `aggregateCredits` 关闭时的 credits 请求
- 非 detail/credits 路径（不匹配 pattern，脚本不触发）

## 具体修改

### 1. `src/tmdb/routes.mjs` — 添加 Forward host 识别

在 `TMDB_IMAGE_HOSTS` 定义之后添加：

```js
const FORWARD_HOSTS = new Set(["forwardinfo.vvebo.vip"]);

function isForwardHost(hostname) {
	return FORWARD_HOSTS.has(String(hostname).toLowerCase());
}
```

在 export 行中添加 `FORWARD_HOSTS` 和 `isForwardHost`。

### 2. `src/tmdb/request-rules.mjs` — 添加条件重定向逻辑

- 在 import 行中添加 `isForwardHost`（以及 `getRequestLanguage`、`isChineseLanguage` 已在 import 中）。
- 在 `applyTmdbRequestRules` 函数中，在 `const route = parseTmdbRoute(url);` 之前（config 解析之后）插入：

```js
if (isForwardHost(url.hostname)) {
	// 构造 TMDB 等价 URL 用于路由解析
	const tmdbUrl = new URL(url.toString());
	tmdbUrl.host = "api.tmdb.org";
	tmdbUrl.pathname = "/3" + url.pathname;
	const forwardRoute = parseTmdbRoute(tmdbUrl);

	// 检查是否需要修改 URL 或参数（与下方 TMDB 处理逻辑一致）
	let needsRedirect = false;
	if (forwardRoute?.isDetail && config.aliasFallback && isChineseLanguage(getRequestLanguage(url))) {
		needsRedirect = true;
	}
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
		if (!tmdbUrl.searchParams.get("api_key")) {
			tmdbUrl.searchParams.set("api_key", DEFAULT_TMDB_API_KEY);
		}
		return {
			$request: request,
			$response: { status: 302, headers: { Location: tmdbUrl.toString() } },
			state,
			config,
		};
	}

	// 不需要修改：放行到 forwardinfo（签名完好）
	request.url = url.toString();
	return { $request: request, state, config };
}
```

**注意**：`state` 已初始化为默认值，`config` 已解析（清除 `proxy.*` 参数）。`url` 是 `new URL(request.url)` 副本。条件判断与下方现有 TMDB 处理逻辑完全一致，确保只重定向真正需要修改的请求。

### 3. `src/process/Request.mjs` — 透传 $response

```js
async function Request($request) {
	const { $request: processedRequest, $response } = await applyTmdbRequestRules($request);
	return { $request: processedRequest, $response };
}
```

### 4. `src/module-manifest.mjs` — 添加脚本规则和 MITM 域名

在 `scriptRules` 数组中添加新规则（放在现有 TMDB Request 规则之后）：

```js
{
	title: "Forward 播放器反代重定向",
	comment: "需要修改的 forwardinfo.vvebo.vip 反代请求重定向到 TMDB",
	phase: "http-request",
	pattern: String.raw`^https:\/\/forwardinfo\.vvebo\.vip\/(?:movie|tv|collection)\/\d+(?:(?:\/season\/\d+)?\/credits|\/alternative_titles)?(?:\?.*)?$`,
	scriptFile: REQUEST_SCRIPT_FILE,
	timeout: 10,
	argumentKeys: ALL_ARGUMENT_KEYS,
},
```

Pattern 与现有 TMDB Request 规则一致（去掉 `/3` 前缀，换为 forwardinfo host），只匹配可能需要修改的 detail/credits 路径。

在 `mitmHosts` 数组中添加 `"forwardinfo.vvebo.vip"`：

```js
const mitmHosts = ["api.themoviedb.org", "api.tmdb.org", "vidora-tmdb.wwmm.date", "image.tmdb.org", "forwardinfo.vvebo.vip"];
```

### 5. 测试 — `tests/tmdb_proxy.test.mjs`

在 import 行中添加 `isForwardHost`：
```js
import { isForwardHost, isTmdbHost, isTmdbImageHost } from "../src/tmdb/routes.mjs";
```

添加以下测试：

```js
test("Forward TV season credits 请求（aggregateCredits 开启）重定向到 TMDB", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/tv/272432/season/1/credits?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aggregateCredits: true } });
	assert.ok(result.$response, "should return redirect response");
	assert.equal(result.$response.status, 302);
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.hostname, "api.tmdb.org");
	assert.equal(location.pathname, "/3/tv/272432/season/1/credits");
	assert.equal(location.searchParams.get("language"), "zh-CN");
	assert.equal(location.searchParams.get("api_key"), DEFAULT_TMDB_API_KEY);
});

test("Forward 中文详情请求（aliasFallback 开启）重定向到 TMDB", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	assert.ok(result.$response);
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.pathname, "/3/movie/550");
});

test("Forward 英文详情请求不重定向（无需修改）", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=en-US", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true, aggregateCredits: true } });
	assert.equal(result.$response, undefined);
	assert.equal(request.url, "https://forwardinfo.vvebo.vip/movie/550?language=en-US");
});

test("Forward credits 请求 aggregateCredits 关闭时不重定向", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/tv/272432/credits?language=zh-CN", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aggregateCredits: false } });
	assert.equal(result.$response, undefined);
});

test("Forward 重定向 URL 保留已有 api_key 不覆盖", async () => {
	const request = { method: "GET", url: "https://forwardinfo.vvebo.vip/movie/550?language=zh-CN&api_key=custom-key", headers: {} };
	const result = await applyTmdbRequestRules(request, { argument: { aliasFallback: true } });
	const location = new URL(result.$response.headers.Location);
	assert.equal(location.searchParams.get("api_key"), "custom-key");
});

test("isForwardHost 识别 forwardinfo 域名", () => {
	assert.equal(isForwardHost("forwardinfo.vvebo.vip"), true);
	assert.equal(isForwardHost("api.tmdb.org"), false);
});
```

### 6. 测试 — `tests/module_manifest.test.mjs`

已有循环 `for (const host of mitmHosts)` 自动覆盖 `forwardinfo.vvebo.vip`。添加断言：

```js
assert.match(generated["dist/tmdb_proxy.plugin"], /forwardinfo\\\.vvebo\\\.vip/);
```

### 7. 重新构建 dist 文件

运行 `npm run build`（或 `node scripts/build-modules.mjs`）重新生成 dist 产物。

## 假设与决策

1. **条件重定向**：只有需要修改 URL/参数的 forward 请求才重定向。判断条件与 `applyTmdbRequestRules` 现有逻辑完全一致（detail+中文+aliasFallback、credits+aggregateCredits、append_to_response=credits+aggregateCredits）。
2. **不需要修改时放行**：返回 `$response: undefined`，请求原样发送到 forwardinfo（签名完好）。
3. **302 重定向**：在请求脚本中返回 `$response`，所有代理工具行为一致，无需渲染 URL Rewrite 语法。
4. **Pattern 与 TMDB 一致**：`^https:\/\/forwardinfo\.vvebo\.vip\/(?:movie|tv|collection)\/\d+...` 只匹配可能需要修改的 detail/credits 路径，不匹配列表等路径（脚本不触发，请求直接到 forwardinfo）。
5. **api_key 注入重定向 URL**：重定向后请求匹配现有 TMDB pattern，脚本会注入 api_key；但重定向 URL 中也带 api_key 作为安全兜底。已有 api_key 时不覆盖。
6. **Hono 入口不受影响**：Hono 的 `routeRewrite` 在 `applyTmdbRequestRules` 之前已将 URL 重写为 api.themoviedb.org。
7. **不修改 response 处理**：重定向后响应自动走已有响应脚本 pattern。

## 验证步骤

1. `npm test` — 全部测试通过（原有 + 新增 6 个）
2. `npm run build` — dist 文件重新生成
3. 检查 `dist/tmdb_proxy.plugin` 包含 forwardinfo.vvebo.vip 的 MITM 和脚本规则
4. 验证重定向场景：`forwardinfo.vvebo.vip/tv/272432/season/1/credits?language=zh-CN` + aggregateCredits → 302 → `api.tmdb.org/3/tv/272432/season/1/credits?language=zh-CN&api_key=<key>`
5. 验证放行场景：`forwardinfo.vvebo.vip/movie/550?language=en-US` → 不重定向，请求到 forwardinfo
