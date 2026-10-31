import { identityKeyOf } from "../core/identity";
import type { EventField } from "./events";

/** The limits of an event's booking form. The rules that need several fields at once are checked by parseFields (admin-events.ts). */
export const MAX_FIELDS = 4;
export const MAX_FIELD_LABEL_CODE_POINTS = 40;
export const MAX_FIELD_LENGTH = 80;
export const MAX_IDENTITY_LIMIT = 20;

/** A field as an admin describes it: the same as a stored one, without the position (the order of the list is the position). */
export type FieldDraft = Omit<EventField, "position">;

/** What an event or template made without saying has: one required field, "Name", which is the identity. */
export const DEFAULT_FIELDS: readonly FieldDraft[] = [{ label: "Name", required: true, maxLength: MAX_FIELD_LENGTH, identity: true }];

/**
 * What an event or template has when it has no field rows: the form every event had before the fields could be configured, Dog and
 * Handler. Migration 0018 gives the existing ones these rows; one made by the previous version of the app in the moments between
 * the migration and the deploy has none, and its bookings are Dog and Handler too.
 */
export const LEGACY_FIELDS: readonly EventField[] = [
  { position: 1, label: "Dog", required: true, maxLength: MAX_FIELD_LENGTH, identity: true },
  { position: 2, label: "Handler", required: true, maxLength: MAX_FIELD_LENGTH, identity: true },
];

/** The fields as a list a draft or a request can carry: no positions. */
export const draftsOf = (fields: readonly EventField[]): FieldDraft[] =>
  fields.map(({ label, required, maxLength, identity }) => ({ label, required, maxLength, identity }));

/** A field's number in the list: 1 to 4, which is the bookings column (`value_1` to `value_4`) it is kept in. */
export const withPositions = (fields: readonly FieldDraft[]): EventField[] => fields.map((f, i) => ({ position: i + 1, ...f }));

/** The text of the bookings columns `value_1` to `value_4` for a booking whose form had these values, in field order: "" for what it didn't ask. */
export const columnValues = (values: readonly string[]): [string, string, string, string] =>
  [values[0] ?? "", values[1] ?? "", values[2] ?? "", values[3] ?? ""];

/** The identity key of a booking whose form had these values: the keys of the identity fields' values, in field order. */
export const identityKeyFor = (fields: readonly { identity: boolean }[], values: readonly string[]): string =>
  identityKeyOf(fields.flatMap((f, i) => (f.identity ? [values[i]] : [])));

/** The values a booking shows, as labelled pairs in field order; a field left blank (an optional one) is left out. */
export const shownValues = (fields: readonly { label: string }[], values: readonly string[]): { label: string; value: string }[] =>
  fields.flatMap((f, i) => (values[i] ? [{ label: f.label, value: values[i] }] : []));

/**
 * How a new list of fields differs from the stored one. `shape` is a change of the number of fields or of which ones identify
 * a booking: once an event has bookings that is not allowed, as their values and identity keys depend on it. `matters` also
 * counts the required flags and the longest values, which a booking request validates against, so a request that read the old
 * ones must notice (config_rev, db-guard.ts). `any` also counts the labels, which only change what is shown.
 */
export function fieldChange(stored: readonly EventField[], next: readonly FieldDraft[]): { shape: boolean; matters: boolean; any: boolean } {
  const shape = stored.length !== next.length || stored.some((f, i) => f.identity !== next[i].identity);
  const rules = stored.some((f, i) => f.required !== next[i]?.required || f.maxLength !== next[i]?.maxLength);
  const labels = stored.some((f, i) => f.label !== next[i]?.label);
  return { shape, matters: shape || rules, any: shape || rules || labels };
}

/** A label as it reads inside a sentence: "Dog" is "dog", "Car reg" is "car reg", and "NHS number" stays as it is. */
const inSentence = (label: string): string => {
  const [first, ...rest] = [...label];
  return /^\p{Lu}(?!\p{Lu})/u.test(label) ? first.toLocaleLowerCase("en-GB") + rest.join("") : label;
};

/** "That dog and handler already have a booking for this event." (one identity field: "That name already has ..."). */
export function duplicateMessage(fields: readonly EventField[]): string {
  const names = fields.filter((f) => f.identity).map((f) => inSentence(f.label));
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `That ${list} already ${names.length > 1 ? "have" : "has"} a booking for this event.`;
}
