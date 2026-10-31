/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What the ASSETS binding does, for the one thing the handlers read from it: files in public/. Anything else is a 404. */
export const publicAssets = (): Fetcher & { requested: string[] } => {
  const requested: string[] = [];
  return {
    requested,
    async fetch(request: Request) {
      const { pathname } = new URL(request.url);
      requested.push(pathname);
      if (pathname.includes("..")) return new Response("not found", { status: 404 });
      try {
        return new Response(readFileSync(join(import.meta.dirname, "../../public", pathname)), { headers: { "Content-Type": "image/png" } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  } as Fetcher & { requested: string[] };
};

export const PAGE_ETAG = '"page-etag-1"';

/**
 * What the ASSETS binding does for the two pages the Worker rewrites: "/" is public/index.html and "/event" is public/event.html,
 * each with an ETag, and a request that sends that ETag in If-None-Match gets a 304 with no body, as the real asset service does.
 * `requests` keeps every request it was given, so a test can see what was (and was not) passed on.
 */
export const pageAssets = (): Fetcher & { requests: Request[] } => {
  const requests: Request[] = [];
  const files: Record<string, string> = { "/": "index.html", "/event": "event.html" };
  return {
    requests,
    async fetch(request: Request) {
      requests.push(request);
      const file = files[new URL(request.url).pathname];
      if (!file) return new Response("not found", { status: 404 });
      if (request.headers.get("If-None-Match") === PAGE_ETAG) return new Response(null, { status: 304, headers: { ETag: PAGE_ETAG } });
      return new Response(readFileSync(join(import.meta.dirname, "../../public", file)), {
        headers: { "Content-Type": "text/html; charset=utf-8", ETag: PAGE_ETAG, "Cache-Control": "public, max-age=0, must-revalidate" },
      });
    },
  } as Fetcher & { requests: Request[] };
};
