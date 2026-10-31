import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

// The committed wrangler.jsonc itself, not a generated wrangler.json that Wrangler would prefer if `npm run configure` has been run.
const config = (env?: string) => unstable_readConfig({ config: join(import.meta.dirname, "../../wrangler.jsonc"), env }, {});

const dbOf = (env?: string) => {
  const dbs = config(env).d1_databases;
  return dbs.find((d: { binding: string }) => d.binding === "DB");
};

it("gives production and preview separate DB bindings", () => {
  const prod = dbOf();
  const preview = dbOf("preview");
  expect(prod).toBeDefined();
  expect(preview).toBeDefined();
  expect(preview?.database_name).not.toBe(prod?.database_name);
  expect(preview?.database_id).not.toBe(prod?.database_id);
});

it("keeps the production database name", () => {
  expect(dbOf()?.database_name).toBe("slot-booker-db");
});

it("is a Worker (not a Pages project) whose entry point is src/worker.ts", () => {
  const raw = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
  expect(raw).not.toContain("pages_build_output_dir");
  expect(config().name).toBe("slot-booker");
  expect(config().main).toBe(join(import.meta.dirname, "../worker.ts"));
});

// The Worker must see these paths before the static files do, so the admin guards and the API cannot be skipped. Every
// path under /admin and /api/admin is covered by "/admin", "/admin/*" and "/api/*"; the Worker's own guard then decides.
// Changing this list changes what can be reached without the guards: do it on purpose.
it("runs the Worker first for exactly the paths the guards and routes need", () => {
  for (const env of [undefined, "preview"]) {
    expect(config(env).assets?.run_worker_first, String(env)).toEqual(["/", "/e/*", "/api/*", "/admin", "/admin/*", "/setup", "/recover"]);
  }
});

it("serves public/ as static assets through the ASSETS binding, in production and preview", () => {
  for (const env of [undefined, "preview"]) {
    expect(config(env).assets?.binding, String(env)).toBe("ASSETS");
    expect(config(env).assets?.directory, String(env)).toBe("./public");
  }
});

it("turns off per-version preview URLs, in production and preview", () => {
  for (const env of [undefined, "preview"]) expect(config(env).preview_urls, String(env)).toBe(false);
});

// Explicit so Wrangler does not warn that workers_dev is missing, and so the button's workers.dev URL keeps working.
it("sets workers_dev explicitly to true at the top level", () => {
  expect(readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8")).toMatch(/^\s*"workers_dev": true,/m);
  expect(config().workers_dev).toBe(true);
});

it("has no ADMIN_AUTH variable in production or preview", () => {
  for (const env of [undefined, "preview"]) expect(config(env).vars?.ADMIN_AUTH, String(env)).toBeUndefined();
});

it("does not publish test files from public/ as static assets", () => {
  const ignore = readFileSync(join(import.meta.dirname, "../../public/.assetsignore"), "utf8").split("\n").map((l) => l.trim());
  expect(ignore).toContain("*.test.ts");
});
