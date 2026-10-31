/**
 * Headers every response from the Worker carries. public/_headers applies only to static files Cloudflare serves
 * itself, not to anything the Worker returns (API, redirects, errors, or files it fetches through ASSETS), so the
 * same set is applied here. src/worker/headers.test.ts fails if this and the `/*` block of public/_headers differ.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/**
 * The response with each of SECURITY_HEADERS added if it does not already set one (the icon and logo routes set
 * their own stricter CSP, which must win). Rebuilds the response because headers of one from the ASSETS binding can be immutable.
 */
export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(name)) out.headers.set(name, value);
  return out;
}
