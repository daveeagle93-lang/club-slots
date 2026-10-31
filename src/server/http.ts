/** The headers the API's own responses set (via `json`); withSecurityHeaders (src/worker/headers.ts) adds the rest to every Worker response. */
export const apiHeaders = { "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex" };

export const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(apiHeaders)) merged.set(name, value);
  return Response.json(body, { status, headers: merged });
};

export const errorResponse = (status: number, code: string, message: string, extra: object = {}, headers: HeadersInit = {}): Response =>
  json({ error: { code, message }, ...extra }, status, headers);

/** A plain-text response (no-store, nosniff), for the Worker's own short refusals. */
export const plain = (status: number, text: string, headers: HeadersInit = {}): Response =>
  new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
