# TMDB Proxy

TMDB API v3 反向代理与本地代理工具脚本模块。支持 Vercel、Cloudflare Workers，以及 Loon、Egern、Surge、Quantumult X。

## 功能
1. 缺少中文标题时，使用别名补全
2. 中文角色名（仅支持部分中日韩影片）
3. 演职人员从主演改为整剧/整季聚合演员
4. TMDB 图片时强制请求 WebP 格式，更省流量

## 代理工具配置

脚本直接 MITM 以下主机，不会调用 Vercel 后端：

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
| `cacheBackend` | `https://tmdb-proxy.demojameson.de5.net` | 远端缓存后端地址，留空用默认 |

配置优先级：默认值 < BoxJs < 插件参数。
