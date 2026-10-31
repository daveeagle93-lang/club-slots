/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");

export interface StagedDb {
  /** The database as it is now (a new connection after every applyThrough). */
  readonly env: { DB: D1Database };
  /** Applies migrations up to and including this number ("0018") with the real `wrangler d1 migrations apply --local`. */
  applyThrough(last: string): Promise<void>;
  /** Opens the connection; only fork needs it (a new StagedDb starts closed until applyThrough). */
  reopen(): Promise<void>;
  /** An independent copy of the database as it is now, to try more than one thing from the same state. */
  fork(): Promise<StagedDb>;
  dispose(): Promise<void>;
}

/**
 * A real local D1 migrated only up to `last` ("0014"): a throwaway project directory holds a copy of that part of
 * migrations/ and a minimal Wrangler config, so the repository's own config (and any generated wrangler.json) is not
 * involved. applyThrough later copies in more migration files and runs the real `migrations apply` again, which is
 * what an existing deployment does when it updates: the migrations already recorded as applied are skipped.
 */
export async function createStagedDb(last: string): Promise<StagedDb> {
  const dir = mkdtempSync(join(tmpdir(), "slot-booker-staged-"));
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "staged-db", compatibility_date: "2026-09-28",
    d1_databases: [{
      binding: "DB", database_name: "slot-booker-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "migrations",
    }],
  }));
  const staged = stagedAt(dir);
  await staged.applyThrough(last);
  return staged;
}

function stagedAt(dir: string): StagedDb {
  const configPath = join(dir, "wrangler.jsonc");
  const persist = join(dir, "state");
  let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | null = null;
  const open = async () => {
    process.env.WRANGLER_REGISTRY_PATH = join(dir, "registry"); // see createTestEnv in db.ts
    proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: join(persist, "v3") } });
  };
  const close = async () => { await proxy?.dispose(); proxy = null; };

  return {
    get env() { return { DB: proxy!.env.DB }; },
    async applyThrough(through) {
      await close();
      for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f.slice(0, 4) <= through)) {
        copyFileSync(join(MIGRATIONS, f), join(dir, "migrations", f));
      }
      execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist, "-c", configPath], {
        cwd: dir, stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      });
      await open();
    },
    async fork() {
      await close();
      const copy = mkdtempSync(join(tmpdir(), "slot-booker-staged-"));
      cpSync(dir, copy, { recursive: true });
      const forked = stagedAt(copy);
      await open();
      await forked.reopen();
      return forked;
    },
    reopen: open,
    async dispose() {
      await close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The statements of a migration file as D1's prepare() takes them: comment lines dropped, split at semicolons (no file has one in a string). */
export function statementsOf(sql: string): string[] {
  return sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
}

export const migrationFile = (prefix: string): string => {
  const name = readdirSync(MIGRATIONS).find((f) => f.startsWith(`${prefix}_`));
  if (!name) throw new Error(`no migration ${prefix}`);
  return join(MIGRATIONS, name);
};
