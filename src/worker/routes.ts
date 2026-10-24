import type { AuthDeps } from "../server/auth";
import { onRequestGet as adminEventsGet, onRequestPost as adminEventsPost } from "../routes/api/admin/events/index";
import { onRequestPost as adminClearPast } from "../routes/api/admin/events/clear-past";
import { onRequestPost as adminPreview } from "../routes/api/admin/events/preview";
import {
  onRequestDelete as adminEventDelete, onRequestGet as adminEventGet, onRequestPut as adminEventPut,
} from "../routes/api/admin/events/[slug]/index";
import { onRequestPost as adminArchive } from "../routes/api/admin/events/[slug]/archive";
import { onRequestGet as adminExportCsv } from "../routes/api/admin/events/[slug]/export.csv";
import { onRequestPost as adminEventPreview } from "../routes/api/admin/events/[slug]/preview";
import { onRequestPost as adminAddBooking } from "../routes/api/admin/events/[slug]/bookings/index";
import { onRequestPost as adminSwap } from "../routes/api/admin/events/[slug]/bookings/swap";
import { onRequestDelete as adminDeleteBooking } from "../routes/api/admin/events/[slug]/bookings/[id]/index";
import { onRequestPost as adminMove } from "../routes/api/admin/events/[slug]/bookings/[id]/move";
import { onRequestGet as adminTemplatesGet, onRequestPost as adminTemplatesPost } from "../routes/api/admin/templates/index";
import {
  onRequestDelete as adminTemplateDelete, onRequestGet as adminTemplateGet, onRequestPut as adminTemplatePut,
} from "../routes/api/admin/templates/[id]/index";
import { createLoginHandler } from "../routes/api/admin/login";
import { onRequestPost as adminLogout } from "../routes/api/admin/logout";
import { onRequestGet as adminSession } from "../routes/api/admin/session";
import { onRequestPut as adminIconPut } from "../routes/api/admin/settings/icons/[size]";
import { onRequestGet as adminSettingsGet, onRequestPut as adminSettingsPut } from "../routes/api/admin/settings/index";
import { onRequestDelete as adminLogoDelete, onRequestPut as adminLogoPut } from "../routes/api/admin/settings/logo";
import { onRequestDelete as adminThemeDelete, onRequestPut as adminThemePut } from "../routes/api/admin/settings/theme";
import { onRequestGet as publicEvents } from "../routes/api/events/index";
import { onRequestGet as publicEvent } from "../routes/api/events/[slug]/index";
import { onRequestPost as publicBook } from "../routes/api/events/[slug]/bookings";
import { onRequestGet as publicIcs } from "../routes/api/events/[slug]/bookings/[token]/ics";
import { onRequestGet as health } from "../routes/api/health";
import { onRequest as icon } from "../routes/api/icon/[size]";
import { onRequest as logo } from "../routes/api/logo";
import { onRequest as manifest } from "../routes/api/manifest.webmanifest";
import { createRecoverHandler } from "../routes/api/recover";
import { createSetupHandler, createSetupStatusHandler } from "../routes/api/setup";
import { onRequestGet as publicSettings } from "../routes/api/settings";
import { onRequest as themeCss } from "../routes/api/theme.css";
import { onRequest as favicon } from "../routes/favicon.ico";
import type { Route } from "./router";
import { serveEventPage, serveLandingPage, serveRecoverPage, serveSetupPage } from "./static";

/**
 * Every route the Worker answers itself. Anything not listed is a 404 (under /api/) or a static file. The admin guard
 * is decided from the path alone, before this table is consulted (worker.ts), so an `access: "admin"` entry is
 * a statement of what the guard already enforces for /api/admin/*, and src/worker/routes.test.ts holds the two together.
 * Adding a route is a conscious edit here; adding a file under src/routes/ without it fails that test.
 *
 * `deps` are for tests (a fixed clock, a stubbed Access key fetch).
 */
export function createRoutes(deps?: AuthDeps): Route[] {
  return [
    // The admin API. Handlers still call refuseUnlessAdmin(data) themselves.
    { method: "GET", pattern: "/api/admin/events", handler: adminEventsGet, access: "admin" },
    { method: "POST", pattern: "/api/admin/events", handler: adminEventsPost, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/clear-past", handler: adminClearPast, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/preview", handler: adminPreview, access: "admin" },
    { method: "GET", pattern: "/api/admin/events/:slug", handler: adminEventGet, access: "admin" },
    { method: "PUT", pattern: "/api/admin/events/:slug", handler: adminEventPut, access: "admin" },
    { method: "DELETE", pattern: "/api/admin/events/:slug", handler: adminEventDelete, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/:slug/archive", handler: adminArchive, access: "admin" },
    { method: "GET", pattern: "/api/admin/events/:slug/export.csv", handler: adminExportCsv, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/:slug/preview", handler: adminEventPreview, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/:slug/bookings", handler: adminAddBooking, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/:slug/bookings/swap", handler: adminSwap, access: "admin" },
    { method: "DELETE", pattern: "/api/admin/events/:slug/bookings/:id", handler: adminDeleteBooking, access: "admin" },
    { method: "POST", pattern: "/api/admin/events/:slug/bookings/:id/move", handler: adminMove, access: "admin" },
    { method: "GET", pattern: "/api/admin/templates", handler: adminTemplatesGet, access: "admin" },
    { method: "POST", pattern: "/api/admin/templates", handler: adminTemplatesPost, access: "admin" },
    { method: "GET", pattern: "/api/admin/templates/:id", handler: adminTemplateGet, access: "admin" },
    { method: "PUT", pattern: "/api/admin/templates/:id", handler: adminTemplatePut, access: "admin" },
    { method: "DELETE", pattern: "/api/admin/templates/:id", handler: adminTemplateDelete, access: "admin" },
    { method: "POST", pattern: "/api/admin/login", handler: createLoginHandler(deps), access: "admin" },
    { method: "POST", pattern: "/api/admin/logout", handler: adminLogout, access: "admin" },
    { method: "GET", pattern: "/api/admin/session", handler: adminSession, access: "admin" },
    { method: "GET", pattern: "/api/admin/settings", handler: adminSettingsGet, access: "admin" },
    { method: "PUT", pattern: "/api/admin/settings", handler: adminSettingsPut, access: "admin" },
    { method: "PUT", pattern: "/api/admin/settings/icons/:size", handler: adminIconPut, access: "admin" },
    { method: "PUT", pattern: "/api/admin/settings/logo", handler: adminLogoPut, access: "admin" },
    { method: "DELETE", pattern: "/api/admin/settings/logo", handler: adminLogoDelete, access: "admin" },
    { method: "PUT", pattern: "/api/admin/settings/theme", handler: adminThemePut, access: "admin" },
    { method: "DELETE", pattern: "/api/admin/settings/theme", handler: adminThemeDelete, access: "admin" },

    // The public API.
    { method: "GET", pattern: "/api/events", handler: publicEvents, access: "public" },
    { method: "GET", pattern: "/api/events/:slug", handler: publicEvent, access: "public" },
    { method: "POST", pattern: "/api/events/:slug/bookings", handler: publicBook, access: "public" },
    { method: "GET", pattern: "/api/events/:slug/bookings/:token/ics", handler: publicIcs, access: "public" },
    { method: "GET", pattern: "/api/health", handler: health, access: "public" },
    { method: "*", pattern: "/api/icon/:size", handler: icon, access: "public" },
    { method: "*", pattern: "/api/logo", handler: logo, access: "public" },
    { method: "*", pattern: "/api/manifest.webmanifest", handler: manifest, access: "public" },
    // Recovery with the recovery code. Public, so it guards itself (src/routes/api/recover.ts): 404 unless a recovery code is stored.
    { method: "POST", pattern: "/api/recover", handler: createRecoverHandler(deps), access: "public" },
    { method: "GET", pattern: "/api/settings", handler: publicSettings, access: "public" },
    // First-run admin setup. Public, so it guards itself (src/server/setup.ts): 404 unless setup is open. GET only reports the state.
    { method: "GET", pattern: "/api/setup", handler: createSetupStatusHandler(deps), access: "public" },
    { method: "POST", pattern: "/api/setup", handler: createSetupHandler(deps), access: "public" },
    { method: "*", pattern: "/api/theme.css", handler: themeCss, access: "public" },
    { method: "*", pattern: "/favicon.ico", handler: favicon, access: "public" },

    // The public pages the Worker sees first (wrangler.jsonc run_worker_first). Other static files never reach it.
    { method: "GET", pattern: "/", handler: serveLandingPage, access: "public" },
    { method: "GET", pattern: "/e/:slug", handler: serveEventPage, access: "public" },
    { method: "GET", pattern: "/setup", handler: serveSetupPage, access: "public" },
    { method: "GET", pattern: "/recover", handler: serveRecoverPage, access: "public" },
  ];
}
