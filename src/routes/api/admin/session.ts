import { adminAuthFor, type AdminData } from "../../../server/auth";
import { parseAccessConfig } from "../../../server/auth/access";
import { csrfToken } from "../../../server/auth/csrf";
import { pinAccess } from "../../../server/auth/settings";
import { noStore } from "../../../server/bookings";
import type { RouteHandler } from "../../../server/env";
import { json } from "../../../server/http";

/** Who is signed in, and the token to send as X-CSRF-Token on writes. Behind guardAdminApi, so only reached when signed in. */
export const onRequestGet: RouteHandler<string, AdminData> = async ({ env, data, request }) => {
  // Reaching here through env-configured Access is a real sign-in, so record it in D1: a later loss of the env line then changes nothing.
  const config = env.ADMIN_AUTH === "access" ? parseAccessConfig(env) : null;
  if (config) {
    try {
      await pinAccess(env.DB, { ...config, hostname: new URL(request.url).hostname }, new Date().toISOString());
    } catch (e) {
      console.error(`Access pin failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const resolved = await adminAuthFor(env);
  const provider = "auth" in resolved ? resolved.auth.kind : null;
  return json({ identity: data.admin.identity, provider, csrfToken: await csrfToken(data.admin.csrfBinding) }, 200, noStore);
};
