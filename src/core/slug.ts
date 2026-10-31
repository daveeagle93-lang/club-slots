/** 128 random bits as 22 base64url characters. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unguessable public identifier for an event (events use sequential integer ids internally). */
export const generateSlug = randomId;

/** Unguessable per-booking token: the only thing a booking's .ics link contains. */
export const generateBookingToken = randomId;

// The upper bound is permissive so SQL-backfilled slugs and tokens (32 hex characters) are valid too.
const ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const isValidSlug = (s: string): boolean => ID_PATTERN.test(s);
export const isValidToken = (s: string): boolean => ID_PATTERN.test(s);
