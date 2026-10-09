// 统一部署入口，直接复用 Hono 应用实例。
// 根目录入口用于直接对接 Vercel 与 Cloudflare Workers 部署。
export { default } from "./src/Hono.js";
