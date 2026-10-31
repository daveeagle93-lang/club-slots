/** Readers for the non-secret Worker variables in AppEnv (src/server/env.ts). Pure: each takes the raw string. */

/** The notice when none is set: built from the labels of the event's booking form, so it names what the form really asks for. */
export const defaultPrivacyNotice = (labels: readonly string[]): string =>
  `We store the details you enter on this form (${labels.join(", ")}) and the slot you choose so the club can run the event. `
  + "The club's organisers can see these details; other people using this page only see which slots are taken. "
  + "The organisers may share the running order, with names, with other participants (for example in a group chat). "
  + "The details are kept until an organiser deletes the event; nothing is deleted automatically.";

const MAX_PRIVACY_NOTICE_CODE_POINTS = 1000;
const MAX_CUTOFF_OFFSET_MINUTES = 7 * 24 * 60;

/** Whole minutes in [-10080, 10080]; unset gives 0, and anything else gives 0 with a warning. */
export function bookingCutoffOffsetMinutes(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const text = raw.trim();
  const minutes = /^[+-]?\d+$/.test(text) ? Number(text) : NaN;
  if (Math.abs(minutes) <= MAX_CUTOFF_OFFSET_MINUTES) return minutes;
  console.warn(`BOOKING_CUTOFF_OFFSET_MINUTES must be a whole number from -${MAX_CUTOFF_OFFSET_MINUTES} to ${MAX_CUTOFF_OFFSET_MINUTES}; using 0.`);
  return 0;
}

/** The trimmed notice, cut to 1000 code points (with a warning), or the default for these field labels if blank or unset. */
export function privacyNotice(raw: string | undefined, labels: readonly string[]): string {
  const text = raw?.trim() ?? "";
  if (text === "") return defaultPrivacyNotice(labels);
  const points = [...text];
  if (points.length <= MAX_PRIVACY_NOTICE_CODE_POINTS) return text;
  console.warn(`PRIVACY_NOTICE is longer than ${MAX_PRIVACY_NOTICE_CODE_POINTS} characters; truncating it.`);
  return points.slice(0, MAX_PRIVACY_NOTICE_CODE_POINTS).join("");
}
