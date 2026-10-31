import { describe, expect, it } from "vitest";
import { executeArgs, migrateArgs, parseArgs } from "../../scripts/seed-args";

describe("parseArgs", () => {
  it("defaults to local with bookings", () => {
    expect(parseArgs([])).toEqual({ mode: "local", withBookings: true });
    expect(parseArgs(["--local"])).toEqual({ mode: "local", withBookings: true });
  });

  it("accepts --no-bookings", () => {
    expect(parseArgs(["--no-bookings"])).toEqual({ mode: "local", withBookings: false });
    expect(parseArgs(["--remote", "--env", "preview", "--no-bookings"])).toEqual({ mode: "remote-preview", withBookings: false });
  });

  it("accepts --remote with --env preview in either order", () => {
    expect(parseArgs(["--remote", "--env", "preview"])).toEqual({ mode: "remote-preview", withBookings: true });
    expect(parseArgs(["--env", "preview", "--remote"])).toEqual({ mode: "remote-preview", withBookings: true });
  });

  it("refuses --remote without --env", () => {
    expect(parseArgs(["--remote"])).toEqual({ error: expect.stringContaining("--env preview") });
  });

  it("refuses any --env other than preview", () => {
    expect(parseArgs(["--remote", "--env", "production"])).toEqual({ error: expect.stringContaining("production") });
    expect(parseArgs(["--remote", "--env", "staging"])).toEqual({ error: expect.stringContaining("staging") });
  });

  it("refuses --env without a value", () => {
    expect(parseArgs(["--remote", "--env"])).toEqual({ error: expect.stringContaining("--env") });
  });

  it("refuses --env preview without --remote", () => {
    expect(parseArgs(["--env", "preview"])).toEqual({ error: expect.stringContaining("--remote") });
    expect(parseArgs(["--local", "--env", "preview"])).toEqual({ error: expect.stringContaining("--remote") });
  });

  it("refuses --local with --remote", () => {
    expect(parseArgs(["--local", "--remote", "--env", "preview"])).toEqual({ error: expect.stringContaining("--local") });
  });

  it("refuses unknown flags and stray arguments, showing usage", () => {
    for (const bad of [["--wipe"], ["--env=preview"], ["preview"], ["--remote", "--env", "preview", "--yes"]]) {
      expect(parseArgs(bad)).toEqual({ error: expect.stringContaining("Usage") });
    }
  });
});

describe("wrangler argv", () => {
  it("builds the local migrate and execute commands against the production-named database", () => {
    expect(migrateArgs()).toEqual(["d1", "migrations", "apply", "slot-booker-db", "--local"]);
    expect(executeArgs("local", "/tmp/x.sql")).toEqual(["d1", "execute", "slot-booker-db", "--local", "--file", "/tmp/x.sql"]);
  });

  it("passes --persist-to for local runs", () => {
    expect(migrateArgs("/state")).toEqual(["d1", "migrations", "apply", "slot-booker-db", "--local", "--persist-to", "/state"]);
    expect(executeArgs("local", "/tmp/x.sql", "/state")).toEqual(
      ["d1", "execute", "slot-booker-db", "--local", "--persist-to", "/state", "--file", "/tmp/x.sql"]);
  });

  it("builds the remote preview command with the DB binding, --remote and --env preview", () => {
    expect(executeArgs("remote-preview", "/tmp/x.sql")).toEqual(
      ["d1", "execute", "DB", "--remote", "--env", "preview", "--file", "/tmp/x.sql"]);
  });

  it("ignores persist-to for remote runs", () => {
    expect(executeArgs("remote-preview", "/tmp/x.sql", "/state")).not.toContain("--persist-to");
  });
});
