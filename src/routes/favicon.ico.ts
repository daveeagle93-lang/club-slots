import type { RouteHandler } from "../server/env";
import { serveIcon } from "../server/icons";

/** `/favicon.ico`: browsers ask for it with no <link>. It is the 32 px app icon (PNG content, which browsers accept). */
export const onRequest: RouteHandler = ({ request, env }) => serveIcon(request, env, 32);
