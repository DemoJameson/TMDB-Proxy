// 统一部署入口，直接复用 Hono 应用实例。
// Unified deployment entry that reuses the Hono application instance.
// 根目录入口用于直接对接 Vercel 与 Cloudflare Workers 部署。
// The root entry is intended to be used directly for Vercel and Cloudflare Workers deployments.
export { default } from "./src/Hono.js";
