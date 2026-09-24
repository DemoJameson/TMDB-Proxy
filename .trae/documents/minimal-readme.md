# 极简化 README 计划

## 目标

将现有 285 行中英双语的 `README.md` 替换为一份**仅中文、极简**的 README，只保留用户指定的四块内容：功能说明、代理工具配置、反代使用、TMDB API Key 申请。删除所有通用模板内容（Quick Start、Project Layout、Key Dependencies、GitHub Actions、Release Notes、Supported Payload Formats、Customization Notes、Runtime Model 等）以及双语英文段落。

## 决策（来自用户确认）

- 语言：**仅中文**
- 代理工具配置范围：**仅订阅链接 + 参数表**，不含 `npm install` / `npm run build` 本地构建说明（用户直接订阅官方 raw 链接）

## 涉及文件

- `README.md`（根目录，整体替换）

唯一改动文件。不新增文件，不改动 `src/`、`dist/` 或配置文件。

## 新 README 结构与内容

### 标题 + 一句话简介

```
# TMDB Proxy

TMDB API v3 反向代理与本地代理工具脚本模块。支持 Vercel、Cloudflare Workers，以及 Loon、Egern、Surge、Quantumult X。
```

依据：`package.json` description + `dist/tmdb_proxy.plugin` 的 `#!desc`。

### 功能

无序列表，每条一行，来源 `src/module-manifest.mjs` 的 scriptRules 注释 + 现有 README 功能段 + `src/tmdb/routes.mjs`：

- 中文 `movie` / `tv` / `collection` 详情缺中文标题时，单次请求追加 `alternative_titles`，按 `zh` / `zh-CN` / `zh-SG` / `zh-TW` / `zh-HK` 地区优先级回填并做简繁转换。
- 返回 `results` 列表的电影、剧集、混合搜索接口，同样为缺中文标题的条目按需回填。
- TV 系列 `credits` 默认改写为 `aggregate_credits`，返回整剧聚合演员；可在配置关闭。
- 演员角色名使用豆瓣数据汉化。
- 请求 TMDB 图片时优先 WebP 格式。
- 脚本模式本地缓存中文别名 7 天，存于 `dj_tmdb_proxy_cache`，最多 1000 条，FIFO 淘汰。
- HTTP 模式可选 Upstash Redis / Vercel KV 作为远端缓存后端。
- 支持 `forwardinfo.vvebo.vip` 反代请求重定向到 TMDB。

### 代理工具配置

**MITM 主机**（来源 `src/module-manifest.mjs` mitmHosts）：
`api.themoviedb.org`、`api.tmdb.org`、`vidora-tmdb.wwmm.date`、`image.tmdb.org`、`forwardinfo.vvebo.vip`

**订阅链接**（RAW_BASE = `https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main`）：

| 平台 | 订阅文件 |
| --- | --- |
| Loon / Egern | `https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.plugin` |
| Surge | `https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.sgmodule` |
| Quantumult X | `https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.snippet` |
| BoxJs | `https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/boxjs.json` |

**一键安装**（来源 `src/module-manifest.mjs` boxjs.descsHtml，按原 URL 原样列出）：

- Egern：`egern:/modules/new?name=TMDB%20Proxy&url=<上面 plugin 链接 encode>`
- Loon：`https://www.nsloon.com/openloon/import?plugin=<plugin 链接 encode>`
- Surge：`surge:///install-module?url=<sgmodule 链接 encode>`
- QX：`https://quantumult.app/x/open-app/add-resource?remote-resource=<snippet 链接 encode>`

> 实现时直接从 `src/module-manifest.mjs` 第 129-132 行复制完整 encode 后的链接，不在 README 里手写 encode 占位。

**参数表**（来源 `src/module-manifest.mjs` argumentFields，顺序、默认值、说明保持一致）：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `aliasFallback` | `true` | 缺少中文标题时，使用别名补全 |
| `characterTranslation` | `true` | 使用豆瓣数据汉化演职员角色名 |
| `aggregateCredits` | `true` | 演职人员从主演改为整剧/整季聚合演员 |
| `imageWebp` | `true` | 请求 TMDB 图片时优先 WebP，更省流量 |
| `cacheBackend` | `https://tmdb-proxy.demojameson.de5.net` | 远端缓存后端地址，留空用默认 |

**配置优先级**：默认值 < BoxJs < 插件参数（来源 `src/module-manifest.mjs` descsHtml 末行 + `src/tmdb/config.mjs` resolveProxyConfig 调用顺序）。脚本直接 MITM `api.themoviedb.org` 等域名，不调用 Vercel 后端。

### 反向代理使用

**Vercel**（来源 `vercel.json` rewrites + 现有 README）：
- 部署后访问 `/api/3/...`，例：`/api/3/movie/550?language=zh-CN`
- 同时支持 `/3/...` 与 `/cache/...`（由 `vercel.json` rewrites 统一转发到 `/api`）

**Cloudflare Workers**（来源 `wrangler.jsonc` + `src/Hono.js` 路由注册）：
- 部署后访问 `/3/...`，例：`https://xxx.workers.dev/3/movie/550?language=zh-CN`
- 缓存端点：`POST /cache/get`、`POST /cache/set`（同时注册了 `/api/cache/*` 兼容路径）
- 部署：`npx wrangler deploy`（`wrangler.jsonc` 已配置 `index.js` 入口与 `nodejs_compat`）

**本地**（来源 `scripts/serve-local.mjs` + 现有 README）：
```bash
npm run dev
```
默认监听 `0.0.0.0:8080`，可用 `HOST`、`PORT` 环境变量覆盖。支持 `/3/...`、`/api/3/...`、`/health`。

**请求凭证**（来源 `src/tmdb/api-key.mjs` getTmdbApiKey + `src/Hono.js` injectTmdbCredential）：
- 请求缺 `api_key` 且无 `Authorization` 时自动注入；客户端已传入的原样保留。
- Key 来源：环境变量 `TMDB_API_KEY`（反代）→ 脚本端本地缓存 → 脚本端向缓存后端 `GET /key` 拉取；未配置且拉取失败时不注入。

**环境变量**：

| 变量 | 用途 | 必填 |
| --- | --- | --- |
| `TMDB_API_KEY` | TMDB v3 API Key，反代注入 `api_key` 并经 `GET /key` 下发给脚本端；未配置时不再注入 | 反代必填 |
| `TMDB_ACCESS_TOKEN` | TMDB v4 Bearer Token，注入 `Authorization` 头 | 否 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 远端缓存 | 否 |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV 远端缓存（与 Upstash 二选一） | 否 |
| `TMDB_ALIAS_FALLBACK` | 覆盖 `aliasFallback` 开关 | 否 |
| `TMDB_AGGREGATE_CREDITS` | 覆盖 `aggregateCredits` 开关 | 否 |
| `TMDB_IMAGE_WEBP` | 覆盖 `imageWebp` 开关 | 否 |
| `TMDB_CHARACTER_TRANSLATION` | 覆盖 `characterTranslation` 开关 | 否 |

来源：`src/tmdb/config.mjs` readEnvironmentConfig 的 map + `src/Hono.js` initCacheStore 的 Upstash/KV 兼容逻辑。

### TMDB API Key 申请

- 访问 https://www.themoviedb.org/settings/api
- 注册/登录账号 → Settings → API → 申请 API Key
- v3 API Key 填入反代环境变量 `TMDB_API_KEY`
- v4 Access Token（可选）填入 `TMDB_ACCESS_TOKEN`
- 脚本模式 MITM 时优先用客户端自带 key，缺 key 时向缓存后端 `GET /key` 获取；HTTP 模式必须先配置 `TMDB_API_KEY`，不再有内置默认 key。

## 假设与决策

1. **整体替换**：直接覆盖 `README.md`，不保留任何旧段落（含双语英文、Quick Start、Project Layout、GitHub Actions、Release Notes 等）。用户「极简化」+「等内容即可」明确要求只留四块。
2. **仅中文**：所有正文中文，删除英文翻译段。
3. **不含构建说明**：代理工具配置部分只给订阅链接与参数表；`npm install` / `npm run build` 不写入 README（用户确认）。
4. **链接原样复制**：一键安装链接直接从 `src/module-manifest.mjs` 第 129-132 行复制已 encode 的完整 URL，避免手写 encode 出错。
5. **不新增 License / Contributing 等章节**：超出用户指定范围，保持极简。
6. **版本号不写入 README 正文**：`package.json` 已维护版本，README 不重复。

## 验证步骤

1. 用 Read 工具通读新 `README.md`，确认：
   - 仅含四块内容 + 标题简介，无旧模板残留。
   - 全篇中文，无英文段落。
   - 参数表 5 行，顺序与 `src/module-manifest.mjs` argumentFields 一致，默认值一致。
   - 订阅链接 4 条，域名/路径与 `src/module-manifest.mjs` RAW_BASE_URL + MODULE_PATH 一致。
   - 环境变量表与 `src/tmdb/config.mjs` + `src/Hono.js` 实际读取的变量名一致。
2. 检查所有订阅链接与一键安装链接可被复制粘贴使用（URL 已完整 encode）。
3. 确认 README 未引入任何对不存在文件/变量的引用（全部来自 Phase 1 实读文件）。
4. 无需运行测试或构建——README 是纯文档改动。
