import { refuseUnlessAdmin } from "../../../../server/admin-context";
import {
  checkEventKey, createdBody, createEvent, findEventByKey, invalidInput, listAdminEvents, parseEventDraft, readEventBody,
  type CreateEventResult,
} from "../../../../server/admin-events";
import { noStore } from "../../../../server/bookings";
import { bookingCutoffOffsetMinutes } from "../../../../server/config";
import type { RouteHandler } from "../../../../server/env";
import { errorResponse, json } from "../../../../server/http";

const internalError = (what: string, e: unknown): Response => {
  console.error(`${what} failed:`, e instanceof Error ? e.message : String(e));
  return errorResponse(500, "internal_error", "Something went wrong. Please try again.", {}, noStore);
};

export const onRequestGet: RouteHandler = async ({ env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  try {
    return json(await listAdminEvents(env.DB, new Date(), bookingCutoffOffsetMinutes(env.BOOKING_CUTOFF_OFFSET_MINUTES)), 200, noStore);
  } catch (e) {
    return internalError("listAdminEvents", e);
  }
};

export const onRequestPost: RouteHandler = async ({ request, env, data }) => {
  const refused = refuseUnlessAdmin(data);
  if (refused) return refused;
  const body = await readEventBody(request);
  if (body instanceof Response) return body;
  // The key belongs to this endpoint only: the preview stores nothing, so it doesn't send one.
  const key = checkEventKey(body.idempotencyKey);
  const now = new Date();
  const parsed = parseEventDraft(body, { now, requireFuture: true });
  if ("message" in key) return invalidInput({ ...("fields" in parsed ? parsed.fields : {}), idempotencyKey: key.message });

  let result: CreateEventResult | null;
  try {
    if ("draft" in parsed) {
      result = await createEvent(env.DB, parsed.draft, key.key);
    } else {
      // Only a start that is no longer in the future (or too far ahead) may be wrong: a retry of a request that
      // was already saved is still answered with its event, as booking retries are after the window closes.
      const lenient = parseEventDraft(body, { now, requireFuture: false });
      if ("fields" in lenient) return invalidInput(parsed.fields);
      result = await findEventByKey(env.DB, key.key, lenient.draft);
      if (!result) return invalidInput(parsed.fields);
    }
  } catch (e) {
    return internalError("createEvent", e);
  }
  switch (result.kind) {
    case "created":
      return json(createdBody(result.saved), 201, noStore);
    case "replayed":
      return json(createdBody(result.saved), 201, { ...noStore, "Idempotent-Replayed": "true" });
    case "idempotency_key_reuse": {
      const message = "An earlier attempt with this key already saved an event, so this change wasn't applied.";
      return errorResponse(422, "idempotency_key_reuse", message, createdBody(result.saved), noStore);
    }
  }
};
