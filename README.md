# TMDB Proxy

TMDB API v3 反向代理与本地代理工具脚本模块。支持 Vercel、Cloudflare Workers，以及 Loon、Egern、Surge、Quantumult X。

## 功能
1. 缺少中文标题时，使用别名补全
2. 中文角色名（仅支持部分中日韩影片）
3. 演职人员从主演改为整剧/整季聚合演员
4. TMDB 图片时强制请求 WebP 格式，更省流量

## 代理工具配置

脚本直接 MITM 以下主机，仅在补齐中文数据或更新 API Key 时访问缓存后端：

`api.themoviedb.org`、`api.tmdb.org`、`vidora-tmdb.wwmm.date`、`image.tmdb.org`、`forwardinfo.vvebo.vip`

脚本链接：

| 平台 | 链接                                                                                                          |
| --- |-------------------------------------------------------------------------------------------------------------|
| Loon / Egern | [tmdb_proxy.plugin](https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.plugin)   |
| Surge | [tmdb_proxy.sgmodule](https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.sgmodule) |
| Quantumult X | [tmdb_proxy.snippet](https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/tmdb_proxy.snippet) |
| BoxJs | [boxjs.json](https://raw.githubusercontent.com/DemoJameson/TMDB-Proxy/main/dist/boxjs.json)                 |

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `aliasFallback` | `true` | 缺少中文标题时，使用别名补全 |
| `characterTranslation` | `true` | 使用豆瓣数据汉化演职员角色名 |
| `aggregateCredits` | `true` | 演职人员从主演改为整剧/整季聚合演员 |
| `imageWebp` | `true` | 请求 TMDB 图片时优先 WebP，更省流量 |
| `cacheBackend` | `https://tmdb-proxy.demojameson.de5.net` | 远端缓存与 API Key 地址，留空用默认 |

配置优先级：默认值 < BoxJs < 插件参数。

脚本不内置 TMDB API Key：缺少 `api_key` 的请求会先用本地缓存，再向 `cacheBackend` 的 `/key` 拉取后端下发的 Key；当 TMDB 判定**本代理注入的那个 Key** 失效（401）时，脚本会立即清掉本地缓存并重新拉取（客户端自带凭证或 Forward 反代自身的 401 不触发刷新）。

## 反代部署

需在后端配置环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `TMDB_API_KEY` | TMDB v3 API Key，反代据此注入 `api_key`，并通过 `GET /key`（Vercel 为 `/api/key`）下发脚本端 |
| `TMDB_ACCESS_TOKEN` | v4 Bearer Token，注入 `Authorization` 头，可选 |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis 远端缓存，可选（Vercel KV 用 `KV_REST_API_URL` / `KV_REST_API_TOKEN`） |

未配置 `TMDB_API_KEY` 时：反代不再注入 Key（客户端需自带），`/key` 返回 503。

`/key` 与缓存端点一样无鉴权，任何调用者都能取到该 Key；若需收敛，请在 Key 轮换或加访问控制上处理。
