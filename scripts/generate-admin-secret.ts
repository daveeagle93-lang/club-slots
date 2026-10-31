// Makes a new admin secret for the password provider and the ADMIN_PASSWORD_HASH value that verifies it.
//
//   npm run --silent generate-admin-secret > hash.txt    the secret appears on the terminal (stderr) only
//
// The secret goes to stderr, once, and is not stored anywhere. Only the hash goes to stdout, so redirecting
// stdout can't capture the secret. Takes no arguments and reads no input.
import { generateAdminSecret, hashAdminSecret } from "../src/server/auth/crypto.ts";

if (process.argv.length > 2) {
  process.stderr.write("This script takes no arguments and reads no input. Run it with no arguments.\n");
  process.exit(1);
}

const secret = generateAdminSecret();
const hash = await hashAdminSecret(secret);
process.stderr.write(
  `Admin secret (shown once; store it in your password manager now):\n${secret}\n\n`
  + "The line on stdout is the ADMIN_PASSWORD_HASH value to store as a Cloudflare secret or in .dev.vars.\n"
  + "It cannot be turned back into the secret.\n",
);
process.stdout.write(`${hash}\n`);
