# @nsnanocat/template

开箱即用的请求/响应脚本模板，同时预留了 Hono + Cloudflare Workers 的 HTTP 运行时入口。  
An out-of-the-box request/response script template with an optional Hono + Cloudflare Workers HTTP runtime entry.

## 概览 / Overview

这个模板将核心逻辑收敛到两个可复用函数：`Request($request)` 与 `Response($request, $response)`。  
This template centers the core logic around two reusable functions: `Request($request)` and `Response($request, $response)`.

你可以把它用在两类场景：  
You can use it in two runtime styles:

- 脚本运行时：输出 `dist/request.js` 与 `dist/response.js`，适合 Quantumult X、Surge、Loon 等请求/响应改写场景。  
  Script runtime: build `dist/request.js` and `dist/response.js` for request/response rewriting in tools such as Quantumult X, Surge, and Loon.
- HTTP 运行时：通过根目录 `index.js` 导出 `src/Hono.js`，可直接对接 Vercel 或 Cloudflare Workers。  
  HTTP runtime: the root `index.js` exports `src/Hono.js` and can be wired directly to Vercel or Cloudflare Workers.

## 当前变更 / Current Changes

结合当前仓库代码和未跟踪的 `.github` 目录，这一版模板的重点变化如下：  
Based on the current codebase and the untracked `.github` directory, this version mainly adds the following changes:

- 请求阶段与响应阶段被明确拆分为独立核心模块，入口文件只负责宿主适配。  
  Request and response stages are split into independent core modules, while entry files only handle host adaptation.
- 新增统一部署入口 `index.js`，直接复用 `src/Hono.js`。  
  A unified deployment entry `index.js` now reuses `src/Hono.js` directly.
- 增加 `wrangler.jsonc`，便于 Cloudflare Workers 本地调试与部署。  
  `wrangler.jsonc` is included for local debugging and deployment on Cloudflare Workers.
- 增加 GitHub Actions 模版，覆盖构建、草稿发布、预发布、正式发布与 Workers 部署。  
  GitHub Actions templates are included for build, draft release, pre-release, full release, and Workers deployment.

## 快速开始 / Quick Start

### 1. 安装依赖 / Install dependencies

```bash
npm install
```

### 2. 编写处理逻辑 / Implement your processing logic

主要编辑以下文件：  
Edit these files first:

- `src/process/Request.mjs`：请求发出前的处理逻辑。  
  `src/process/Request.mjs`: request-phase logic before the upstream request is sent.
- `src/process/Response.mjs`：响应返回后的处理逻辑。  
  `src/process/Response.mjs`: response-phase logic after the upstream response is received.

如果你需要保留可读性更高的调试版本，请同步维护：  
If you want a more readable debug build, keep these files in sync as well:

- `src/process/Request.dev.mjs`
- `src/process/Response.dev.mjs`

### 3. 构建脚本产物 / Build script artifacts

生产构建：  
Production build:

```bash
npm run build
```

开发构建：  
Development build:

```bash
npm run build:dev
```

构建结果如下：  
The build outputs are:

- `npm run build` -> `dist/request.js`、`dist/response.js`
- `npm run build:dev` -> `dist/request.dev.js`、`dist/response.dev.js`

### 4. 部署 HTTP 入口 / Deploy the HTTP entry

根目录 `index.js` 会直接导出 Hono 应用，不参与 Rollup 打包。  
The root `index.js` exports the Hono application directly and is not bundled by Rollup.

如果你要在本地或 Cloudflare Workers 上运行 HTTP 入口，可使用：  
If you want to run the HTTP entry locally or on Cloudflare Workers, you can use:

```bash
npx wrangler dev
npx wrangler deploy
```

## 运行模型 / Runtime Model

### 脚本运行时 / Script Runtime

- `src/request.js` / `src/request.dev.js` 负责调用 `Request()` 并把结果交回宿主。  
  `src/request.js` / `src/request.dev.js` call `Request()` and hand the result back to the host.
- `src/response.js` / `src/response.dev.js` 负责调用 `Response()` 并输出最终响应。  
  `src/response.js` / `src/response.dev.js` call `Response()` and return the final response.
- 当 `Request()` 返回 `$response` 时，请求链会被短路。  
  When `Request()` returns `$response`, the request flow short-circuits immediately.

### HTTP 运行时 / HTTP Runtime

`src/Hono.js` 会把传入 HTTP 请求转换成模板约定的 `$request` 结构，先发起上游请求，再执行 `Response()`。  
`src/Hono.js` converts the incoming HTTP request into the template's `$request` shape, fetches upstream first, and then runs `Response()`.

当前 `Request()` 在 `src/Hono.js` 中保留了预处理钩子，但默认注释掉。  
`Request()` is kept as a preprocessing hook in `src/Hono.js`, but it is commented out by default.

如果你需要在 HTTP 入口里也复用请求改写逻辑，可以启用这一段注释代码。  
If you also want request rewriting in the HTTP entry, uncomment that section in `src/Hono.js`.

## 支持的数据格式 / Supported Payload Formats

模板内已经预留了常见内容类型的处理分支：  
The template already includes branches for common content types:

- `application/json` / `text/json`
- `text/plain`
- `application/x-www-form-urlencoded`
- `application/xml`、`text/xml`、`text/html`、`plist`
- `application/vtt`、`text/vtt`
- `application/x-mpegURL` 等 M3U8 类型  
  `application/x-mpegURL` and related M3U8 types
- `application/protobuf`、`application/grpc`、`application/grpc+proto`
- `application/octet-stream`

其中 gRPC / Protobuf 分支已经接入 `@nsnanocat/grpc`，JSON 分支也预留了 `crypto-js` 的加解密示例。  
The gRPC / Protobuf branches already use `@nsnanocat/grpc`, and the JSON branch includes ready-to-edit `crypto-js` encryption/decryption examples.

## 目录结构 / Project Layout

```text
.
├── index.js
├── wrangler.jsonc
├── package.json
├── rollup.config.js
├── rollup.default.config.js
├── rollup.dev.config.js
├── src/
│   ├── Hono.js
│   ├── request.js
│   ├── request.dev.js
│   ├── response.js
│   ├── response.dev.js
│   └── process/
│       ├── Request.mjs
│       ├── Request.dev.mjs
│       ├── Response.mjs
│       └── Response.dev.mjs
└── .github/
    ├── RELEASE-TEMPLATE.md
    ├── actions/node-build/action.yml
    └── workflows/
```

## 关键依赖 / Key Dependencies

- `@nsnanocat/util`：脚本运行时工具、`fetch`、日志和 `done()` 适配。  
  `@nsnanocat/util`: runtime utilities, `fetch`, logging, and `done()` adaptation.
- `@nsnanocat/url`：在 JavaScriptCore 等环境中提供 `URL` 支持。  
  `@nsnanocat/url`: provides `URL` support in environments such as JavaScriptCore.
- `@nsnanocat/grpc`：处理 gRPC 帧编解码。  
  `@nsnanocat/grpc`: handles gRPC frame encoding and decoding.
- `hono`：HTTP 服务入口。  
  `hono`: powers the HTTP service entry.
- `crypto-js`：按需启用的加密与解密工具。  
  `crypto-js`: optional encryption/decryption helpers.

## GitHub Actions / GitHub Actions

当前 `.github` 目录已经准备了可复用的 workflow，但其中一部分依赖仓库 secrets，另一部分需要你先把占位字段改成自己的配置。  
The `.github` directory already includes reusable workflows, but some depend on repository secrets and others require you to replace placeholder fields with your own values first.

### 工作流一览 / Workflow Matrix

| Workflow | 触发方式 / Trigger | 用途 / Purpose | 依赖配置 / Required config | 需要补齐的内容 / Fields to fill |
| --- | --- | --- | --- | --- |
| `build.yml` | `workflow_dispatch`、`workflow_call` | 生产构建，上传 `CHANGELOG.md` 与 `dist/` | `SUBMODULE_TOKEN`、`PACKAGE_TOKEN` | `package.json` 里补 `build:args`，或者删除 workflow 中的 `extra-command: npm run build:args` |
| `dev.yml` | `workflow_dispatch`、`workflow_call` | 基于 `dev` 分支执行开发构建 | `SUBMODULE_TOKEN`、`PACKAGE_TOKEN` | 确保仓库存在 `dev` 分支 |
| `draft.yml` | push `main` | 生成 GitHub Draft Release | 继承 `build.yml` 的变量；`GITHUB_TOKEN` 为 Actions 内置 | 发布前更新 `CHANGELOG.md` |
| `pre-release.yml` | push tag `vX.Y.Z-alpha.N` / `vX.Y.Z-beta.N` | 发布预发布版本 | 继承 `build.yml` 的变量；`GITHUB_TOKEN` 为 Actions 内置 | 发布前更新 `CHANGELOG.md` |
| `release.yml` | push tag `vX.Y.Z` | 发布正式版本 | 继承 `build.yml` 的变量；`GITHUB_TOKEN` 为 Actions 内置 | 发布前更新 `CHANGELOG.md` |
| `deploy.yml` | push `dev` | 将开发构建产物发布到 Gist | `SUBMODULE_TOKEN`、`PACKAGE_TOKEN`、`GIST_TOKEN`、`GIST_ID`、`GIST_DESCRIPTION` | 将 `GIST_ID` / `GIST_DESCRIPTION` 配置为仓库级变量；`GIST_DESCRIPTION` 留空时会回退到 `package.json` 的 `name + "\\n" + description`；`file_path` 仍需改成真实产物名 |
| `workers-dev.yml` | `workflow_dispatch` | 从 `dev` 分支手动部署 Cloudflare Workers | `SUBMODULE_TOKEN`、`PACKAGE_TOKEN`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | 确保 `wrangler.jsonc` 与 Cloudflare 项目配置一致 |
| `workers-release.yml` | `workflow_dispatch` | 从默认分支手动部署 Cloudflare Workers | `SUBMODULE_TOKEN`、`PACKAGE_TOKEN`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | 确保 `wrangler.jsonc` 与 Cloudflare 项目配置一致 |

### 变量与占位字段 / Variables And Placeholder Fields

| 名称 / Name | 类型 / Type | 用在何处 / Used by | 需要填写的内容 / What to provide |
| --- | --- | --- | --- |
| `SUBMODULE_TOKEN` | GitHub Actions secret | `build.yml`、`dev.yml`、`workers-dev.yml`、`workers-release.yml` | 可读取私有 submodule 的 GitHub Token；如果没有私有 submodule，可按需调整 checkout 配置 |
| `PACKAGE_TOKEN` | GitHub Actions secret | 通过 `./.github/actions/node-build` 调用的所有构建流程 | 用于 `npm install` 的 `NODE_AUTH_TOKEN`，通常是私有 npm registry 或 GitHub Packages 访问令牌 |
| `GIST_TOKEN` | GitHub Actions secret | `deploy.yml` | 有权限写入目标 Gist 的 GitHub Token |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret | `workers-dev.yml`、`workers-release.yml` | 具备 Workers 部署权限的 Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secret | `workers-dev.yml`、`workers-release.yml` | Cloudflare Account ID |
| `GITHUB_TOKEN` | GitHub Actions built-in secret | `draft.yml`、`pre-release.yml`、`release.yml` | GitHub 自动提供，通常不需要手动创建 |
| `GIST_ID` | 仓库级 GitHub Actions variable (`vars`) / Repository-scoped GitHub Actions variable (`vars`) | `deploy.yml` | 目标 Gist 的 ID；请求脚本和响应脚本会写入同一个 Gist；请在当前仓库的 `Settings -> Secrets and variables -> Actions -> Variables` 中创建，不要依赖组织级或用户级变量 |
| `GIST_DESCRIPTION` | 仓库级 GitHub Actions variable (`vars`) / Repository-scoped GitHub Actions variable (`vars`) | `deploy.yml` | 可选的 Gist 描述；优先级高于自动生成值；若未设置或为空，则回退为 `package.json` 的 `name` 与 `description` 换行拼接结果；请在当前仓库级 Variables 中创建 |
| `file_path` | Workflow 内占位字段 | `deploy.yml` | 需要和实际构建产物一致；当前仓库默认产物是 `dist/request.dev.js` 与 `dist/response.dev.js`，不是 `dist/request.bundle.js` 与 `dist/response.bundle.js` |
| `build:args` | `package.json` script | `build.yml` | 当前仓库还没有这个脚本；要么补上，要么删除 `extra-command: npm run build:args` |
| `CHANGELOG.md` | 发布正文文件 | `build.yml`、`draft.yml`、`pre-release.yml`、`release.yml` | 每次发布前按 `.github/RELEASE-TEMPLATE.md` 填好内容 |

如果你只是先启用最基础的发版流程，最少需要先准备 `SUBMODULE_TOKEN`、`PACKAGE_TOKEN` 与可发布的 `CHANGELOG.md`。  
If you only want to enable the basic release flow first, the minimum setup is `SUBMODULE_TOKEN`, `PACKAGE_TOKEN`, and a ready-to-publish `CHANGELOG.md`.

## 发布说明 / Release Notes

`CHANGELOG.md` 应按 `.github/RELEASE-TEMPLATE.md` 维护，因为 Draft / Pre-Release / Release 工作流都会直接把它当成发布正文。  
`CHANGELOG.md` should follow `.github/RELEASE-TEMPLATE.md`, because the Draft / Pre-Release / Release workflows use it directly as the release body.

建议流程如下：  
Recommended flow:

1. 发布前复制或更新 `CHANGELOG.md` 中的模版内容。  
   Before release, copy or update the template content in `CHANGELOG.md`.
2. 将 `none` 替换为这次版本的实际变更。  
   Replace `none` with the real changes for the version.
3. 创建符合语义化版本的标签，再触发对应工作流。  
   Create a semantic version tag and trigger the matching workflow.

## 自定义建议 / Customization Notes

- 如果你只需要脚本平台，重点维护 `src/process/*.mjs` 与 `dist/` 产物即可。  
  If you only target script platforms, focus on `src/process/*.mjs` and the `dist/` outputs.
- 如果你要提供 HTTP API，再根据自己的上游服务调整 `src/Hono.js`。  
  If you also expose an HTTP API, adapt `src/Hono.js` to your upstream service.
- 如果你需要请求阶段的 HTTP 预处理，启用 `src/Hono.js` 中注释掉的 `Request()` 钩子。  
  If you need request-phase preprocessing in HTTP mode, enable the commented `Request()` hook in `src/Hono.js`.
