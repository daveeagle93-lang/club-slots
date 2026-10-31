import type { RouteHandler } from "../../server/env";
export const onRequestGet: RouteHandler = () => Response.json({ ok: true });
