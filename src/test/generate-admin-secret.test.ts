/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isCanonicalAdminSecret, parseAdminSecretHash, verifyAdminSecret } from "../server/auth/crypto";

const run = (args: string[] = []) =>
  spawnSync(process.execPath, ["scripts/generate-admin-secret.ts", ...args], { input: "", encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });

/** The secret from the labelled line on stderr. */
const secretOf = (stderr: string) => stderr.match(/^([A-Za-z0-9_-]{43})$/m)?.[1];

describe("scripts/generate-admin-secret.ts", () => {
  it("prints the secret on stderr and only the verifying hash on stdout", async () => {
    const out = run();
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^hmac-sha256\$[\w-]+\$[\w-]+\n$/);
    const secret = secretOf(out.stderr)!;
    expect(secret).toBeDefined();
    expect(isCanonicalAdminSecret(secret)).toBe(true);
    expect(out.stderr).toContain("shown once");
    expect(out.stdout).not.toContain(secret);
    const parsed = parseAdminSecretHash(out.stdout.trim())!;
    expect(parsed).not.toBeNull();
    expect(await verifyAdminSecret(secret, parsed)).toBe(true);
    expect(out.stderr).not.toContain(out.stdout.trim());
  });

  it("makes a different secret and salt every run", () => {
    const [a, b] = [run(), run()];
    expect(secretOf(a.stderr)).not.toBe(secretOf(b.stderr));
    expect(a.stdout).not.toBe(b.stdout);
  });

  it("refuses arguments, and prints neither a secret nor a hash", () => {
    for (const args of [["x"], ["--help"], ["a-perfectly-long-secret", "--other"]]) {
      const out = run(args);
      expect(out.status, args.join(" ")).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain("no arguments");
      expect(out.stderr).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(out.stderr).not.toContain("hmac-sha256");
      expect(out.stderr).not.toContain(args[0]);
    }
  });
});
