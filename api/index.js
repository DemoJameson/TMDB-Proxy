import { getRequestListener } from "@hono/node-server";
import app from "../dist/api.mjs";

export default getRequestListener(app.fetch);
