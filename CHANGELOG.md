<!-- 按 .github/RELEASE-TEMPLATE.md 维护当前版本的发布说明。 -->
<!-- Maintain the current release notes based on .github/RELEASE-TEMPLATE.md. -->

### 🆕 New Features
  * none

### 🛠️ Bug Fixes
  * 修复 Forward（forwardinfo.vvebo.vip）中文搜索列表（/search/movie、/search/tv 等）无法补全中文片名：脚本发起的详情子请求在 Loon 等代理工具中不会经过请求脚本注入 api_key，现改为子请求自带 api_key，并剥离 Forward 专属的鉴权/CDN 头（X-Signature、X-Timestamp、Authorization、Cookie、Host）。

### 🔣 Dependencies
  * none

### ‼️ Breaking Changes
  * none

### 🔄 Other Changes
  * none
