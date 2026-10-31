// Keeps your Cloudflare account's database IDs (and any club-specific settings) out of the committed
// wrangler.jsonc, without editing it.
//
//   npm run configure             reads account.local.json (git-ignored; shape in account.local.example.json),
//                                 takes wrangler.jsonc as the template and writes wrangler.json (git-ignored)
//   npm run configure -- --clear  removes the generated wrangler.json, so Wrangler uses wrangler.jsonc again
//
// Wrangler looks for wrangler.json before wrangler.jsonc in the same directory, so the generated file
// takes over every command (dev, deploy, d1 ..., the tests) with env.preview intact.
// See docs/deploying.md, step 3. Plain Node (type stripping), hence the explicit .ts extensions.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { buildConfig, describeJsonError, describeReadError, describeVars, isGenerated, parseAccount, renderConfig } from "./configure-core.ts";

const root = join(import.meta.dirname, "..");
const templatePath = join(root, "wrangler.jsonc");
const accountPath = join(root, "account.local.json");
const outPath = join(root, "wrangler.json");
const USAGE = "Usage: npm run configure [-- --clear]";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--clear") || args.length > 1) {
  console.error(`Unknown argument.\n${USAGE}`);
  process.exit(2);
}

const refuseForeign = (): void => {
  if (existsSync(outPath) && !isGenerated(readFileSync(outPath, "utf8"))) {
    console.error("wrangler.json already exists and was not made by this script, so it is left alone. Move or delete it first.");
    process.exit(1);
  }
};

if (args[0] === "--clear") {
  refuseForeign();
  if (existsSync(outPath)) {
    rmSync(outPath);
    console.log("Removed wrangler.json. Wrangler uses the committed wrangler.jsonc (placeholder IDs) again.");
  } else {
    console.log("No generated wrangler.json to remove.");
  }
  process.exit(0);
}

if (!existsSync(accountPath)) {
  console.error("account.local.json not found. Copy account.local.example.json to account.local.json and fill it in.");
  process.exit(1);
}
let raw: unknown;
let accountText = "";
try {
  accountText = readFileSync(accountPath, "utf8");
} catch (e) {
  console.error(describeReadError(e));
  process.exit(1);
}
try {
  raw = JSON.parse(accountText);
} catch (e) {
  console.error(describeJsonError(e, accountText));
  process.exit(1);
}
const parsed = parseAccount(raw);
if ("errors" in parsed) {
  console.error(`account.local.json is not usable:\n${parsed.errors.map((m) => `  - ${m}`).join("\n")}`);
  process.exit(1);
}
refuseForeign();

const { rawConfig } = experimental_readRawConfig({ config: templatePath });
writeFileSync(outPath, renderConfig(buildConfig(rawConfig as Record<string, any>, parsed.account)));

console.log(
  `Wrote wrangler.json from wrangler.jsonc and account.local.json: production and preview database IDs`
  + `${parsed.account.name ? `, Worker name ${parsed.account.name}` : ""}`
  + `, ${describeVars(parsed.account)}.\n`
  + "Wrangler now reads wrangler.json instead of wrangler.jsonc. Run this again after wrangler.jsonc or account.local.json changes.\n"
  + "Undo: npm run configure -- --clear",
);
