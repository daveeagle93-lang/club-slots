/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

// Applies migrations/ once (real wrangler, real D1 migration semantics) to a template
// persistence directory; each test env copies it. See createTestEnv in ./db.ts.
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "slot-booker-template-"));
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", dir], {
    stdio: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  project.provide("templateDir", dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    templateDir: string;
  }
}
