import { adminAuthFor, type AdminData } from "../../../server/auth";
import { noStore } from "../../../server/bookings";
import type { RouteHandler } from "../../../server/env";
import { json } from "../../../server/http";

/**
 * Behind guardAdminApi, so signed in and CSRF-checked. Sessions are stateless: this clears the browser's
 * cookie but cannot revoke a copy of it. Access sessions end at Access, so the client is sent there.
 */
export const onRequestPost: RouteHandler<string, AdminData> = async ({ env }) => {
  const resolved = await adminAuthFor(env);
  if ("error" in resolved || resolved.auth.kind === "access") return json({ logoutUrl: "/cdn-cgi/access/logout" }, 200, noStore);
  return json({ ok: true }, 200, { ...noStore, "Set-Cookie": resolved.auth.clearCookie() });
};
