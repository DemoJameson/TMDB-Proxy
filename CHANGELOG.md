<!-- 按 .github/RELEASE-TEMPLATE.md 维护当前版本的发布说明。 -->
<!-- Maintain the current release notes based on .github/RELEASE-TEMPLATE.md. -->

### 🆕 New Features
  * 新增 `GET /key`（Vercel 为 `GET /api/key`）端点，下发后端环境变量 `TMDB_API_KEY`；脚本端不再内置 API Key，改为从缓存后端拉取并本地缓存，本代理注入的 Key 被 TMDB 判定失效（401）时立即刷新并重试列表详情子请求。

### 🛠️ Bug Fixes
  * 修复 Forward（forwardinfo.vvebo.vip）中文搜索列表（/search/movie、/search/tv 等）无法补全中文片名：脚本发起的详情子请求在 Loon 等代理工具中不会经过请求脚本注入 api_key，现改为子请求自带 api_key，并剥离 Forward 专属的鉴权/CDN 头（X-Signature、X-Timestamp、Authorization、Cookie、Host）。

### 🔣 Dependencies
  * none

### ‼️ Breaking Changes
  * 移除硬编码的 TMDB API Key：反代必须配置环境变量 `TMDB_API_KEY`，未配置时不再注入 `api_key`（客户端需自带凭证）；脚本端改为向 `cacheBackend` 拉取 Key。

### 🔄 Other Changes
  * none
