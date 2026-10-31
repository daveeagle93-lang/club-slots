import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

// What the "Deploy to Cloudflare" button reads from the repository: wrangler.jsonc (not a generated wrangler.json),
// package.json (scripts and binding descriptions) and .dev.vars.example (the secrets it prompts for).
// https://developers.cloudflare.com/workers/platform/deploy-buttons/
const root = join(import.meta.dirname, "../..");
const config = (env?: string) => unstable_readConfig({ config: join(root, "wrangler.jsonc"), env }, {});
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  cloudflare?: { bindings?: Record<string, { description?: unknown }> };
};
const descriptions = pkg.cloudflare?.bindings ?? {};

const exampleLines = readFileSync(join(root, ".dev.vars.example"), "utf8").split("\n");
const liveLines = exampleLines.filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
const liveKeys = liveLines.map((l) => l.slice(0, l.indexOf("=")).trim());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dbOf = (env?: string) => config(env).d1_databases.find((d: { binding: string }) => d.binding === "DB");

describe("package.json scripts", () => {
  it("applies the migrations before it deploys", () => {
    const steps = pkg.scripts.deploy.split("&&").map((s) => s.trim());
    expect(steps).toEqual(["npm run db:migrations:apply", 'wrangler deploy --env=""']);
  });

  it("targets the top-level environment explicitly in both scripts (env.preview is defined, so no --env would warn)", () => {
    expect(pkg.scripts.deploy).toContain('--env=""');
    expect(pkg.scripts["db:migrations:apply"]).toContain('--env=""');
  });

  it("applies migrations to the remote database through the binding name, not the database name", () => {
    const script = pkg.scripts["db:migrations:apply"];
    expect(script).toMatch(/^wrangler d1 migrations apply DB /);
    expect(script).toContain("--remote");
    expect(script).not.toContain("slot-booker-db");
    expect(script).not.toContain("--local");
  });

  it("still has the local migration script the developer docs use", () => {
    expect(pkg.scripts["db:migrate:local"]).toBe("wrangler d1 migrations apply DB --local");
  });
});

describe("wrangler.jsonc as the button reads it", () => {
  it("is a Worker, not a Pages project", () => {
    expect(readFileSync(join(root, "wrangler.jsonc"), "utf8")).not.toContain("pages_build_output_dir");
    expect(config().pages_build_output_dir).toBeUndefined();
  });

  it("names the D1 binding DB, and package.json describes that binding", () => {
    expect(dbOf()?.binding).toBe("DB");
    expect(dbOf("preview")?.binding).toBe("DB");
    expect(Object.keys(descriptions)).toContain("DB");
  });

  it("has default values for the database: a name, a placeholder id and the migrations folder", () => {
    expect(dbOf()?.database_name).toBe("slot-booker-db");
    expect(dbOf()?.database_id).toMatch(UUID);
    expect(dbOf()?.migrations_dir).toBe("migrations");
    const dir = join(root, "migrations");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{4}_.+\.sql$/);
  });

  it("has different placeholder ids for production and preview", () => {
    expect(dbOf("preview")?.database_id).toMatch(UUID);
    expect(dbOf("preview")?.database_id).not.toBe(dbOf()?.database_id);
  });

  it("has no plain variables, so the form shows none", () => {
    // Wrangler fills an absent vars in as {}; configure.test.ts checks the raw file has no vars key at all.
    expect(config().vars).toEqual({});
    expect(config("preview").vars).toEqual({});
  });
});

describe(".dev.vars.example", () => {
  it("has no live line, so the button asks for no secret", () => {
    expect(liveLines).toHaveLength(0);
  });

  it("keeps SETUP_CODE= as a commented-out line, so it is documented but not prompted", () => {
    expect(exampleLines).toContain("# SETUP_CODE=");
  });

  it("is still ignored by git in its copied form but kept itself", () => {
    const ignore = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignore).toContain(".dev.vars");
    expect(ignore).toContain("!.dev.vars.example");
  });
});

describe("cloudflare.bindings descriptions", () => {
  it("describes every live key of .dev.vars.example", () => {
    for (const key of liveKeys) expect(Object.keys(descriptions), key).toContain(key);
  });

  it("describes nothing that is not prompted: only the live example keys and the database", () => {
    expect(Object.keys(descriptions).sort()).toEqual([...new Set(["DB", ...liveKeys])].sort());
  });

  it("gives each a short, non-empty description in plain words", () => {
    for (const [key, value] of Object.entries(descriptions)) {
      const text = value.description;
      expect(typeof text, key).toBe("string");
      const description = text as string;
      expect(description.trim().length, key).toBeGreaterThan(20);
      expect(description.length, key).toBeLessThanOrEqual(400);
      expect(description, key).not.toMatch(/wrangler|binding|\bD1\b/i);
    }
  });
});
