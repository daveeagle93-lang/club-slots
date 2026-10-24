/// <reference types="node" />
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { GENERATED_MARKER, buildConfig, describeJsonError, describeReadError, describeVars, isGenerated, parseAccount, renderConfig } from "../../scripts/configure-core";

const PROD = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const PREVIEW = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const good = { productionDatabaseId: PROD, previewDatabaseId: PREVIEW };

const ok = (raw: unknown) => {
  const r = parseAccount(raw);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r.account;
};
const errorsOf = (raw: unknown) => {
  const r = parseAccount(raw);
  return "errors" in r ? r.errors.join("\n") : "";
};

describe("describeJsonError", () => {
  const describeParse = (text: string): string => {
    try {
      JSON.parse(text);
    } catch (e) {
      return describeJsonError(e, text);
    }
    throw new Error("expected invalid JSON");
  };
  const SECRET = "sk-live-4f9a8b7c6d5e";

  it("gives a generic message with the line and column when the parse error carries a position", () => {
    expect(describeParse('{\n  "a": 1,\n}')).toBe("account.local.json is not valid JSON (line 3, column 1)");
    expect(describeParse('{"a":1,}')).toBe("account.local.json is not valid JSON (line 1, column 8)");
  });

  it("never includes any of the file's text, whatever the error says", () => {
    for (const text of [`{"token": ${SECRET} }`, `{\n "a": ${SECRET}\n}`, `${SECRET}`, `{"a": "${SECRET}",}`]) {
      const out = describeParse(text);
      expect(out, text).not.toContain(SECRET);
      expect(out, text).not.toContain("sk-");
      expect(out, text).toMatch(/^account\.local\.json is not valid JSON( \(line \d+, column \d+\))?$/);
    }
  });

  it("prints no position when the error has none, or when it is not a usable number", () => {
    expect(describeParse('{"a":')).toBe("account.local.json is not valid JSON");
    expect(describeJsonError(new Error("x at position 99999 (line 9 column 9)"), "short")).toBe("account.local.json is not valid JSON");
    expect(describeJsonError(new Error(`${SECRET} at position 99999999999999999999`), "short")).toBe("account.local.json is not valid JSON");
    expect(describeJsonError("not an error", "{}")).toBe("account.local.json is not valid JSON");
  });

  it("counts lines from the text, not from the message", () => {
    expect(describeJsonError(new Error("Unexpected token at position 4"), "ab\ncd\nef")).toBe("account.local.json is not valid JSON (line 2, column 2)");
  });
});

describe("describeReadError", () => {
  it("reports the error code only", () => {
    const e = Object.assign(new Error("EACCES: permission denied, open '/home/x/account.local.json'"), { code: "EACCES" });
    expect(describeReadError(e)).toBe("Couldn't read account.local.json (EACCES).");
    expect(describeReadError(Object.assign(new Error("m"), { code: "EISDIR" }))).toBe("Couldn't read account.local.json (EISDIR).");
  });

  it("omits the code when there is none or it is not a plain error code", () => {
    expect(describeReadError(new Error("boom"))).toBe("Couldn't read account.local.json.");
    expect(describeReadError("nope")).toBe("Couldn't read account.local.json.");
    expect(describeReadError({ code: "sk-live secret text" })).toBe("Couldn't read account.local.json.");
  });
});

describe("parseAccount", () => {
  it("accepts two distinct UUIDs and lower-cases them", () => {
    expect(ok({ productionDatabaseId: PROD.toUpperCase(), previewDatabaseId: PREVIEW })).toEqual({
      productionDatabaseId: PROD, previewDatabaseId: PREVIEW, vars: {},
    });
  });

  it("accepts a name and string vars", () => {
    const a = ok({ ...good, name: "my-club-bookings", vars: { ADMIN_AUTH: "password", BOOKING_CUTOFF_OFFSET_MINUTES: "-30" } });
    expect(a.name).toBe("my-club-bookings");
    expect(a.vars).toEqual({ ADMIN_AUTH: "password", BOOKING_CUTOFF_OFFSET_MINUTES: "-30" });
  });

  it("refuses anything that is not a UUID", () => {
    expect(errorsOf({ ...good, productionDatabaseId: "not-a-uuid" })).toContain("productionDatabaseId");
    expect(errorsOf({ ...good, previewDatabaseId: "" })).toContain("previewDatabaseId");
    expect(errorsOf({ ...good, previewDatabaseId: 7 })).toContain("previewDatabaseId");
    expect(errorsOf({ previewDatabaseId: PREVIEW })).toContain("productionDatabaseId");
  });

  it("refuses the all-zero placeholders, including the committed preview one", () => {
    expect(errorsOf({ ...good, productionDatabaseId: "00000000-0000-0000-0000-000000000000" })).toContain("placeholder");
    expect(errorsOf({ ...good, previewDatabaseId: "00000000-0000-0000-0000-000000000001" })).toContain("placeholder");
  });

  it("refuses production and preview being the same database, whatever the case", () => {
    expect(errorsOf({ productionDatabaseId: PROD, previewDatabaseId: PROD.toUpperCase() })).toContain("different");
  });

  it("refuses unknown keys, so a typo is not silently ignored", () => {
    expect(errorsOf({ ...good, previewDatabaseID: PREVIEW })).toContain("previewDatabaseID");
  });

  it("refuses a file that is not a JSON object", () => {
    expect(errorsOf(null)).toContain("object");
    expect(errorsOf([good])).toContain("object");
    expect(errorsOf("x")).toContain("object");
  });

  it("refuses vars that are not strings, have odd names, or are secrets", () => {
    expect(errorsOf({ ...good, vars: { A: 1 } })).toContain("string");
    expect(errorsOf({ ...good, vars: { "bad name": "x" } })).toContain("bad name");
    expect(errorsOf({ ...good, vars: ["x"] })).toContain("vars");
    expect(errorsOf({ ...good, vars: { ADMIN_PASSWORD_HASH: "x" } })).toContain("secret");
    expect(errorsOf({ ...good, vars: { ADMIN_SESSION_SECRET: "x" } })).toContain("secret");
    expect(errorsOf({ ...good, vars: { SETUP_CODE: "x" } })).toContain("SETUP_CODE is a secret");
  });

  it("accepts productionVars and previewVars alongside vars, each kept apart", () => {
    const a = ok({ ...good, vars: { A: "shared" }, productionVars: { P: "prod" }, previewVars: { V: "preview" } });
    expect(a.vars).toEqual({ A: "shared" });
    expect(a.productionVars).toEqual({ P: "prod" });
    expect(a.previewVars).toEqual({ V: "preview" });
  });

  it("applies the vars rules to productionVars and previewVars, naming the key", () => {
    for (const key of ["productionVars", "previewVars"]) {
      expect(errorsOf({ ...good, [key]: { A: 1 } }), key).toContain(`${key}: A must be a string`);
      expect(errorsOf({ ...good, [key]: { "bad name": "x" } }), key).toContain(`${key}: "bad name"`);
      expect(errorsOf({ ...good, [key]: ["x"] }), key).toContain(`${key} must be an object`);
      expect(errorsOf({ ...good, [key]: null }), key).toContain(`${key} must be an object`);
      expect(errorsOf({ ...good, [key]: { ADMIN_PASSWORD_HASH: "x" } }), key).toContain(`${key}: ADMIN_PASSWORD_HASH is a secret`);
      expect(errorsOf({ ...good, [key]: { ADMIN_SESSION_SECRET: "x" } }), key).toContain(`${key}: ADMIN_SESSION_SECRET is a secret`);
      expect(errorsOf({ ...good, [key]: { SETUP_CODE: "x" } }), key).toContain(`${key}: SETUP_CODE is a secret`);
    }
  });

  it("names the per-environment keys in the unknown-key message", () => {
    const e = errorsOf({ ...good, productionVar: {} });
    expect(e).toContain('Unknown key "productionVar"');
    expect(e).toContain("productionVars");
    expect(e).toContain("previewVars");
  });

  it("refuses a bad project name", () => {
    expect(errorsOf({ ...good, name: "Has Spaces" })).toContain("name");
    expect(errorsOf({ ...good, name: "" })).toContain("name");
    expect(errorsOf({ ...good, name: "-lead" })).toContain("name");
  });

  it("reports every problem at once", () => {
    const e = errorsOf({ productionDatabaseId: "x", previewDatabaseId: "y", vars: { A: 1 } });
    expect(e).toContain("productionDatabaseId");
    expect(e).toContain("previewDatabaseId");
    expect(e).toContain("vars");
  });

  it("rejects the committed example file as it stands, and it holds no real-looking id", () => {
    const text = readFileSync("account.local.example.json", "utf8");
    expect(errorsOf(JSON.parse(text))).not.toBe("");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

const template = () => ({
  $schema: "./node_modules/wrangler/config-schema.json",
  name: "slot-booker",
  compatibility_date: "2026-09-28",
  main: "src/worker.ts",
  assets: { directory: "./public", binding: "ASSETS", run_worker_first: ["/", "/api/*"] },
  preview_urls: false,
  d1_databases: [{ binding: "DB", database_name: "slot-booker-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations" }],
  env: {
    preview: {
      d1_databases: [{ binding: "DB", database_name: "slot-booker-db-preview", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: "migrations" }],
    },
  },
});

describe("buildConfig", () => {
  it("puts each id in its own block and keeps everything else", () => {
    const out = buildConfig(template(), ok(good));
    expect(out.d1_databases).toEqual([{ binding: "DB", database_name: "slot-booker-db", database_id: PROD, migrations_dir: "migrations" }]);
    expect(out.env.preview.d1_databases).toEqual([{ binding: "DB", database_name: "slot-booker-db-preview", database_id: PREVIEW, migrations_dir: "migrations" }]);
    expect(out.name).toBe("slot-booker");
    expect(out.compatibility_date).toBe("2026-09-28");
    expect(out.main).toBe("src/worker.ts");
    expect(out.assets).toEqual(template().assets);
    expect(out.preview_urls).toBe(false);
    expect(out.vars).toBeUndefined();
    expect(out.env.preview.vars).toBeUndefined();
  });

  it("does not change the template it was given", () => {
    const t = template();
    buildConfig(t, ok({ ...good, vars: { ADMIN_AUTH: "password" } }));
    expect(t).toEqual(template());
  });

  it("applies vars to both the top level and env.preview, because vars are not inherited", () => {
    const out = buildConfig(template(), ok({ ...good, vars: { ADMIN_AUTH: "password" } }));
    expect(out.vars).toEqual({ ADMIN_AUTH: "password" });
    expect(out.env.preview.vars).toEqual({ ADMIN_AUTH: "password" });
  });

  it("lets account vars win over template vars and keeps the rest", () => {
    const t: any = template();
    t.vars = { A: "template", B: "template" };
    t.env.preview.vars = { A: "template-preview", C: "template-preview" };
    const out = buildConfig(t, ok({ ...good, vars: { A: "mine" } }));
    expect(out.vars).toEqual({ A: "mine", B: "template" });
    expect(out.env.preview.vars).toEqual({ A: "mine", C: "template-preview" });
  });

  it("puts productionVars only in the top level when there are no shared vars", () => {
    const out = buildConfig(template(), ok({ ...good, productionVars: { ADMIN_AUTH: "access" } }));
    expect(out.vars).toEqual({ ADMIN_AUTH: "access" });
    expect(out.env.preview.vars).toBeUndefined();
  });

  it("puts previewVars only in env.preview when there are no shared vars", () => {
    const out = buildConfig(template(), ok({ ...good, previewVars: { ADMIN_AUTH: "password" } }));
    expect(out.vars).toBeUndefined();
    expect(out.env.preview.vars).toEqual({ ADMIN_AUTH: "password" });
  });

  it("lets an environment's own vars override the shared value in that block only", () => {
    const out = buildConfig(template(), ok({
      ...good,
      vars: { ADMIN_AUTH: "shared", BOOKING_CUTOFF_OFFSET_MINUTES: "-30" },
      productionVars: { ADMIN_AUTH: "access", ACCESS_AUD: "aud" },
      previewVars: { ADMIN_AUTH: "password" },
    }));
    expect(out.vars).toEqual({ ADMIN_AUTH: "access", BOOKING_CUTOFF_OFFSET_MINUTES: "-30", ACCESS_AUD: "aud" });
    expect(out.env.preview.vars).toEqual({ ADMIN_AUTH: "password", BOOKING_CUTOFF_OFFSET_MINUTES: "-30" });
  });

  it("does not leak one environment's own vars into the other", () => {
    const out = buildConfig(template(), ok({ ...good, vars: { S: "s" }, productionVars: { P: "p" }, previewVars: { V: "v" } }));
    expect(out.vars).not.toHaveProperty("V");
    expect(out.env.preview.vars).not.toHaveProperty("P");
    expect(out.vars).toEqual({ S: "s", P: "p" });
    expect(out.env.preview.vars).toEqual({ S: "s", V: "v" });
  });

  it("lets environment vars win over template vars too", () => {
    const t: any = template();
    t.vars = { A: "template", B: "template" };
    t.env.preview.vars = { A: "template-preview", C: "template-preview" };
    const out = buildConfig(t, ok({ ...good, vars: { A: "shared" }, productionVars: { A: "prod" }, previewVars: { C: "mine" } }));
    expect(out.vars).toEqual({ A: "prod", B: "template" });
    expect(out.env.preview.vars).toEqual({ A: "shared", C: "mine" });
  });

  it("overrides the project name only when given", () => {
    expect(buildConfig(template(), ok({ ...good, name: "my-club" })).name).toBe("my-club");
  });

  it("refuses a template without the DB binding in both blocks", () => {
    const noPreview: any = template();
    delete noPreview.env;
    expect(() => buildConfig(noPreview, ok(good))).toThrow(/env\.preview/);
    const noTop: any = template();
    noTop.d1_databases = [];
    expect(() => buildConfig(noTop, ok(good))).toThrow(/top-level/);
  });
});

describe("describeVars", () => {
  it("says there are no vars when none are set", () => {
    expect(describeVars(ok(good))).toBe("no vars");
  });

  it("lists the same names for both blocks when only shared vars are used", () => {
    expect(describeVars(ok({ ...good, vars: { A: "1", B: "2" } }))).toBe("vars (production): A, B; vars (preview): A, B");
  });

  it("lists names per block so the difference shows, without any value", () => {
    const text = describeVars(ok({
      ...good,
      vars: { BOOKING_CUTOFF_OFFSET_MINUTES: "-30", ADMIN_AUTH: "shared-value" },
      productionVars: { ADMIN_AUTH: "access-value", ACCESS_AUD: "aud-value" },
      previewVars: { ADMIN_AUTH: "password-value" },
    }));
    expect(text).toBe("vars (production): BOOKING_CUTOFF_OFFSET_MINUTES, ADMIN_AUTH, ACCESS_AUD; vars (preview): BOOKING_CUTOFF_OFFSET_MINUTES, ADMIN_AUTH");
    for (const value of ["-30", "shared-value", "access-value", "aud-value", "password-value"]) expect(text).not.toContain(value);
  });

  it("says none for a block with no vars", () => {
    expect(describeVars(ok({ ...good, previewVars: { A: "x" } }))).toBe("vars (production): none; vars (preview): A");
  });
});

describe("renderConfig / isGenerated", () => {
  it("starts with the marker and is still parseable by Wrangler, ids resolved per environment", () => {
    const text = renderConfig(buildConfig(template(), ok({ ...good, vars: { ADMIN_AUTH: "password" } })));
    expect(text.startsWith("// " + GENERATED_MARKER)).toBe(true);
    expect(isGenerated(text)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "slot-booker-configure-"));
    try {
      const file = join(dir, "wrangler.json");
      writeFileSync(file, text);
      const dbOf = (env?: string) => unstable_readConfig({ config: file, env }, {}).d1_databases.find((d: { binding: string }) => d.binding === "DB");
      expect(dbOf()?.database_id).toBe(PROD);
      expect(dbOf("preview")?.database_id).toBe(PREVIEW);
      expect(unstable_readConfig({ config: file }, {}).vars).toMatchObject({ ADMIN_AUTH: "password" });
      expect(unstable_readConfig({ config: file, env: "preview" }, {}).vars).toMatchObject({ ADMIN_AUTH: "password" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes per-environment vars that Wrangler reads back per environment", () => {
    const text = renderConfig(buildConfig(template(), ok({ ...good, vars: { S: "s" }, productionVars: { ADMIN_AUTH: "access" }, previewVars: { ADMIN_AUTH: "password" } })));
    const dir = mkdtempSync(join(tmpdir(), "slot-booker-configure-"));
    try {
      const file = join(dir, "wrangler.json");
      writeFileSync(file, text);
      expect(unstable_readConfig({ config: file }, {}).vars).toMatchObject({ S: "s", ADMIN_AUTH: "access" });
      expect(unstable_readConfig({ config: file, env: "preview" }, {}).vars).toMatchObject({ S: "s", ADMIN_AUTH: "password" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim a hand-written wrangler.json as its own", () => {
    expect(isGenerated('{ "name": "x" }')).toBe(false);
    expect(isGenerated("")).toBe(false);
  });

  it("builds from the real committed wrangler.jsonc template", () => {
    const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
    const out = buildConfig(rawConfig as Record<string, any>, ok(good));
    expect(out.d1_databases[0].database_id).toBe(PROD);
    expect(out.env.preview.d1_databases[0].database_id).toBe(PREVIEW);
    expect(out.d1_databases[0].database_name).toBe("slot-booker-db");
  });

  it("adds no vars to the committed template unless the account has some, and sets them per environment", () => {
    const { rawConfig } = experimental_readRawConfig({ config: "wrangler.jsonc" });
    const template = rawConfig as Record<string, any>;
    expect(template.vars).toBeUndefined();
    expect(template.env.preview.vars).toBeUndefined();

    const plain = buildConfig(template, ok(good));
    expect(plain.vars).toBeUndefined();
    expect(plain.env.preview.vars).toBeUndefined();

    const mine = buildConfig(template, ok({
      ...good,
      vars: { BOOKING_CUTOFF_OFFSET_MINUTES: "-30" },
      productionVars: { ADMIN_AUTH: "access", ACCESS_AUD: "aud" },
    }));
    expect(mine.vars).toEqual({ ADMIN_AUTH: "access", BOOKING_CUTOFF_OFFSET_MINUTES: "-30", ACCESS_AUD: "aud" });
    expect(mine.env.preview.vars).toEqual({ BOOKING_CUTOFF_OFFSET_MINUTES: "-30" });
  });
});
