// Pure helpers for scripts/seed.ts, kept apart so tests can import them without running the seed.
export type SeedMode = "local" | "remote-preview";

const USAGE = `Usage: npm run seed -- [--local | --remote --env preview] [--no-bookings]
  (default)                  local D1, as --local
  --remote --env preview     the remote PREVIEW database only (migrations must already be applied)
  --no-bookings              insert the event without the sample bookings`;

export function parseArgs(argv: string[]): { mode: SeedMode; withBookings: boolean } | { error: string } {
  let local = false, remote = false, env: string | undefined, withBookings = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--local") local = true;
    else if (a === "--remote") remote = true;
    else if (a === "--no-bookings") withBookings = false;
    else if (a === "--env") {
      env = argv[++i];
      if (env === undefined || env.startsWith("-")) return { error: `--env needs a value.\n${USAGE}` };
    } else return { error: `Unknown argument: ${a}\n${USAGE}` };
  }
  if (local && remote) return { error: `--local and --remote cannot be combined.\n${USAGE}` };
  if (env !== undefined && env !== "preview") return { error: `Refusing --env ${env}: only preview is seeded, never production.\n${USAGE}` };
  if (remote && env === undefined) return { error: `--remote requires --env preview.\n${USAGE}` };
  if (!remote && env !== undefined) return { error: `--env preview requires --remote.\n${USAGE}` };
  return { mode: remote ? "remote-preview" : "local", withBookings };
}

// The local name is the production database's; the remote preview run uses the DB binding, which
// wrangler resolves within env.preview only, so it cannot reach production.
const LOCAL_DB = "slot-booker-db";

export function migrateArgs(persistTo?: string): string[] {
  return ["d1", "migrations", "apply", LOCAL_DB, "--local", ...(persistTo ? ["--persist-to", persistTo] : [])];
}

export function executeArgs(mode: SeedMode, file: string, persistTo?: string): string[] {
  return mode === "remote-preview"
    ? ["d1", "execute", "DB", "--remote", "--env", "preview", "--file", file]
    : ["d1", "execute", LOCAL_DB, "--local", ...(persistTo ? ["--persist-to", persistTo] : []), "--file", file];
}
