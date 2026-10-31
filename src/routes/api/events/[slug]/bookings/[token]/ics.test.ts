import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateBookingToken } from "../../../../../../core/slug";
import { identityKeyOf } from "../../../../../../core/identity";
import { createTestEnv, insertBookingOf, insertBreak, insertEvent, type TestEnv } from "../../../../../../test/db";
import { bookingUid } from "../../../../../../server/ics";
import { saveSettings } from "../../../../../../server/settings";
import { onRequestPost } from "../../bookings";
import { onRequestGet } from "./ics";

let t: TestEnv;
beforeAll(async () => {
  t = await createTestEnv();
  // The POST test books an event dated 2026-06-13, so the clock must be before it (Date only; timers stay real).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
});
afterAll(async () => {
  vi.useRealTimers();
  await t.dispose();
});

const SLOT = "2026-06-13T08:15:00Z";

const getIcs = (slug: string, token: string): Promise<Response> =>
  Promise.resolve(
    onRequestGet({
      request: new Request(`http://localhost/api/events/${slug}/bookings/${token}/ics`),
      env: t.env,
      params: { slug, token },
    } as unknown as Parameters<typeof onRequestGet>[0]),
  );

/** Inserts a booking row directly (in the event's first lane, place 1) and returns its token. */
async function book(
  eventId: number, slot: string, dog: string, handler: string,
  o: { createdAt?: string; token?: string } = {},
): Promise<string> {
  const token = o.token ?? generateBookingToken();
  await t.env.DB.prepare(
    `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, token${o.createdAt ? ", created_at" : ""})
     VALUES (?, (SELECT id FROM event_lanes WHERE event_id = ? ORDER BY position LIMIT 1), ?, 1, ?, ?, ?, ?${o.createdAt ? ", ?" : ""})`,
  )
    .bind(eventId, eventId, slot, dog, handler, identityKeyOf([dog, handler]), token, ...(o.createdAt ? [o.createdAt] : []))
    .run();
  return token;
}

function vevent(ics: string): ICAL.Event {
  const root = new ICAL.Component(ICAL.parse(ics));
  return new ICAL.Event(root.getFirstSubcomponent("vevent")!);
}

const uidOf = (ics: string): string => vevent(ics).uid;

describe("GET /api/events/:slug/bookings/:token/ics", () => {
  it("serves the .ics for a booking on an unlisted event", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { listed: false });
    const token = await book(id, SLOT, "Rex", "Sam");
    const res = await getIcs(slug, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
  });

  it("returns the .ics for an existing booking, with headers and parseable content", async () => {
    const { id, slug } = await insertEvent(t.env.DB, {
      name: "Summer show", costPence: 1250, venuePostcode: "SW1A 1AA", details: "Bring water",
    });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const res = await getIcs(slug, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="booking.ics"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const ev = vevent(await res.text());
    expect(ev.summary).toContain("Rex");
    expect(ev.summary).toContain("Summer show");
    expect(ev.location).toBe("SW1A 1AA");
    expect(ev.description).toContain("£12.50");
    expect(ev.description).toContain("Bring water");
    expect(ev.description).toContain("Sam Jones");
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-06-13T08:15:00.000Z");
    expect(ev.endDate.toJSDate().toISOString()).toBe("2026-06-13T08:30:00.000Z");
  });

  it("names the booking's lane in the description when the event has a named lane, and keeps the UID, summary and location", async () => {
    const plain = await insertEvent(t.env.DB, { name: "Summer show", lanes: [""] });
    const lanes = await insertEvent(t.env.DB, { name: "Summer show", lanes: ["Ring 1", "Ring 2"] });
    const single = await insertEvent(t.env.DB, { name: "Summer show", lanes: ["Only ring"] });
    const tokenPlain = await book(plain.id, SLOT, "Rex", "Sam");
    const tokenRing2 = await t.env.DB.prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, place, value_1, value_2, identity_key, token) VALUES (?, ?, ?, 1, 'Rex', 'Sam', ?, ?) RETURNING token`,
    ).bind(lanes.id, lanes.laneIds[1], SLOT, identityKeyOf(["Rex", "Sam"]), generateBookingToken()).first<{ token: string }>();
    const tokenSingle = await book(single.id, SLOT, "Rex", "Sam");
    const slotLine = (ics: string) => vevent(ics).description.split("\n").find((l) => l.startsWith("Slot: "));
    const icsPlain = await (await getIcs(plain.slug, tokenPlain)).text();
    const icsRing2 = await (await getIcs(lanes.slug, tokenRing2!.token)).text();
    const icsSingle = await (await getIcs(single.slug, tokenSingle)).text();
    expect(slotLine(icsPlain)).toBe("Slot: 09:15–09:30");
    expect(slotLine(icsRing2)).toBe("Slot: 09:15–09:30, Ring 2");
    expect(slotLine(icsSingle)).toBe("Slot: 09:15–09:30, Only ring");
    expect(vevent(icsRing2).summary).toBe("Rex – Summer show");
    expect(vevent(icsRing2).location).toBe("AB1 2CD");
    expect(uidOf(icsRing2)).toBe(await bookingUid(lanes.slug, identityKeyOf(["Rex", "Sam"])));
  });

  it("is byte-identical on two fetches", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const a = await (await getIcs(slug, token)).text();
    const b = await (await getIcs(slug, token)).text();
    expect(a).toBe(b);
  });

  it("uses the booking's created_at as DTSTAMP", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones", { createdAt: "2026-05-01T12:34:56Z" });
    const text = await (await getIcs(slug, token)).text();
    expect(text).toContain("\r\nDTSTAMP:20260501T123456Z\r\n");
  });

  it("has a stable UID: same for identity variants, different across events and identities", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    const tokenA = await book(a.id, SLOT, "Zoë", "Sam Jones");
    const tokenOther = await book(a.id, "2026-06-13T08:30:00Z", "Rex", "Sam Jones");
    const tokenB = await book(b.id, SLOT, "Zoë", "Sam Jones");
    const uidA = uidOf(await (await getIcs(a.slug, tokenA)).text());
    expect(uidA).toBe(await bookingUid(a.slug, identityKeyOf(["Zoë", "Sam Jones"])));
    expect(uidA).toMatch(/^[0-9a-f]{32}@slot-booker$/);
    expect(uidOf(await (await getIcs(b.slug, tokenB)).text())).not.toBe(uidA);
    expect(uidOf(await (await getIcs(a.slug, tokenOther)).text())).not.toBe(uidA);
    // The same identity re-booked later (new token, differently typed) keeps its UID.
    await t.env.DB.prepare("DELETE FROM bookings WHERE event_id = ? AND identity_key = ?").bind(a.id, identityKeyOf(["Zoë", "Sam Jones"])).run();
    const tokenAgain = await book(a.id, "2026-06-13T09:00:00Z", "ZOË", " sam   jones ");
    expect(uidOf(await (await getIcs(a.slug, tokenAgain)).text())).toBe(uidA);
  });

  it("keeps the UID, and the same link, when the booking's slot is moved by an admin", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const before = uidOf(await (await getIcs(slug, token)).text());
    await t.env.DB.prepare("UPDATE bookings SET slot_start_utc = ? WHERE event_id = ?").bind("2026-06-13T09:00:00Z", id).run();
    const moved = await getIcs(slug, token);
    expect(moved.status).toBe(200);
    const ev = vevent(await moved.text());
    expect(ev.uid).toBe(before);
    expect(ev.startDate.toJSDate().toISOString()).toBe("2026-06-13T09:00:00.000Z");
  });

  it("shows the names as entered, and survives commas, semicolons and emoji", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { name: "Fun; games, etc." });
    const dog = "Rex, the 2nd; 🐕 (good boy)";
    const token = await book(id, SLOT, dog, "Sam \\ Jones, Esq.");
    const ev = vevent(await (await getIcs(slug, token)).text());
    expect(ev.summary).toBe(`${dog} – Fun; games, etc.`);
    expect(ev.description).toContain(`Dog: ${dog}`);
    expect(ev.description).toContain("Handler: Sam \\ Jones, Esq.");
  });

  describe("a configured booking form", () => {
    const FIELDS = [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false }, { label: "Notes", required: false }];
    const tokenOf = async (id: number) => (await t.env.DB.prepare("SELECT token FROM bookings WHERE id = ?").bind(id).first<{ token: string }>())!.token;

    it("names the booking by the first value, and has a `Label: value` line for each value given, in order, leaving out a blank optional one", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { name: "Pony day", fields: FIELDS });
      const booking = await insertBookingOf(t.env.DB, id, FIELDS, SLOT, ["Ann Lee", "Biscuit", "", "Nervous; shy"]);
      const ev = vevent(await (await getIcs(slug, await tokenOf(booking))).text());
      expect(ev.summary).toBe("Ann Lee – Pony day");
      expect(ev.description.split("\n").slice(0, 4)).toEqual(["Rider: Ann Lee", "Pony: Biscuit", "Notes: Nervous; shy", "Slot: 09:15–09:30"]);
    });

    it("has one line for a form of one field", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { name: "Car show", fields: [{ label: "Car reg", identity: true }] });
      const booking = await insertBookingOf(t.env.DB, id, [{ label: "Car reg", identity: true }], SLOT, ["AB12 CDE"]);
      const ev = vevent(await (await getIcs(slug, await tokenOf(booking))).text());
      expect(ev.summary).toBe("AB12 CDE – Car show");
      expect(ev.description.split("\n").slice(0, 2)).toEqual(["Car reg: AB12 CDE", "Slot: 09:15–09:30"]);
    });

    it("keeps the UID from the identity fields only: another phone number is the same entry, another pony is not, and a second booking of an identity is its own entry", async () => {
      const { id, slug } = await insertEvent(t.env.DB, { fields: FIELDS, identityLimit: 2 });
      const a = await insertBookingOf(t.env.DB, id, FIELDS, SLOT, ["Ann", "Biscuit", "111"]);
      const uid = uidOf(await (await getIcs(slug, await tokenOf(a))).text());
      expect(uid).toBe(await bookingUid(slug, identityKeyOf(["Ann", "Biscuit"])));
      await t.env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(a).run();
      const again = await insertBookingOf(t.env.DB, id, FIELDS, "2026-06-13T08:30:00Z", ["ANN", "biscuit", "222"]);
      expect(uidOf(await (await getIcs(slug, await tokenOf(again))).text())).toBe(uid);
      const other = await insertBookingOf(t.env.DB, id, FIELDS, "2026-06-13T08:45:00Z", ["Ann", "Nutmeg"]);
      expect(uidOf(await (await getIcs(slug, await tokenOf(other))).text())).not.toBe(uid);
      const second = await insertBookingOf(t.env.DB, id, FIELDS, "2026-06-13T09:00:00Z", ["Ann", "Nutmeg"]);
      expect(uidOf(await (await getIcs(slug, await tokenOf(second))).text())).toBe(await bookingUid(slug, identityKeyOf(["Ann", "Nutmeg"]), 2));
    });
  });

  it("starts the description with the club name when one is set, and is as before when it is not", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { details: "Bring water" });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    const before = await (await getIcs(slug, token)).text();
    const setClub = (clubName: string) => saveSettings(t.env.DB, { clubName, privacyContact: { name: "", email: "" }, website: "" });
    try {
      const name = "Hill, Dale; \\ Zoë 🐕 Club";
      await setClub(name);
      const text = await (await getIcs(slug, token)).text();
      expect(vevent(text).description.split("\n")[0]).toBe(name);
      expect(vevent(text).description).toContain("Dog: Rex");
      expect(text.replace(/\r\n /g, "")).toContain("DESCRIPTION:Hill\\, Dale\\; \\\\ Zoë 🐕 Club\\nDog: Rex");
      await setClub("");
      expect(await (await getIcs(slug, token)).text()).toBe(before);
    } finally {
      await setClub("");
    }
    expect(vevent(before).description.split("\n")[0]).toBe("Dog: Rex");
  });

  it("never contains other bookings' names", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    await book(id, "2026-06-13T08:30:00Z", "Zxqotherdog", "Zxqotherhandler");
    const text = await (await getIcs(slug, token)).text();
    expect(text).not.toMatch(/Zxq/);
  });

  it("still serves an archived event's existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { archived: true });
    const token = await book(id, SLOT, "Rex", "Sam Jones");
    expect((await getIcs(slug, token)).status).toBe(200);
  });

  it("returns an identical generic 404 for everything that is not an existing booking", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    const other = await insertEvent(t.env.DB);
    await insertBreak(t.env.DB, id, "2026-06-13T09:00:00Z", "2026-06-13T09:30:00Z");
    const good = await book(id, SLOT, "Rex", "Sam Jones", { token: "AbCdEfGhIjKlMnOpQrStUv" });
    const orphan = await book(id, "2026-06-13T09:00:00Z", "Orphan", "Slot"); // in a break: not in the schedule
    const elsewhere = await book(other.id, "2026-06-13T10:00:00Z", "Fido", "Ann Lee");
    const cases: [string, Promise<Response>][] = [
      ["unknown event", getIcs("unknownslug0123456789", good)],
      ["malformed slug", getIcs("short", good)],
      ["valid-format but unknown token", getIcs(slug, generateBookingToken())],
      ["token with its case flipped", getIcs(slug, "aBcDeFgHiJkLmNoPqRsTuV")],
      ["token with a character added", getIcs(slug, `${good}A`)],
      ["token with a trailing newline", getIcs(slug, `${good}\n`)],
      ["malformed token: too short", getIcs(slug, "abc")],
      ["malformed token: path traversal", getIcs(slug, "../../etc/passwd")],
      ["malformed token: empty", getIcs(slug, "")],
      ["malformed token: unicode", getIcs(slug, "é".repeat(22))],
      ["another event's token", getIcs(slug, elsewhere)],
      ["slot no longer in the schedule", getIcs(slug, orphan)],
      ["a token guessed as 'null'", getIcs(slug, "null".padEnd(22, "0"))],
      ["a token guessed as 'NULL'", getIcs(slug, "NULL")],
    ];
    const bodies = new Set<string>();
    for (const [label, pending] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(404);
      expect(res.headers.get("content-type"), label).toContain("application/json");
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(res.headers.get("content-disposition"), label).toBeNull();
      const text = await res.text();
      expect(JSON.parse(text).error.code, label).toBe("not_found");
      bodies.add(text);
    }
    expect(bodies.size).toBe(1);
  });

  it("cannot store a booking without a token, so no guessed token such as 'null' reaches one", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await book(id, SLOT, "Rex", "Sam Jones");
    await expect(t.env.DB.prepare(
      `INSERT INTO bookings (event_id, lane_id, slot_start_utc, value_1, identity_key, token)
       VALUES (?, ?, '2026-06-13T08:30:00Z', 'Fido', 'fido', NULL)`,
    ).bind(id, (await t.env.DB.prepare("SELECT id FROM event_lanes WHERE event_id = ?").bind(id).first<{ id: number }>())!.id).run())
      .rejects.toThrow(/NOT NULL constraint failed/);
    for (const token of [generateBookingToken(), "null", "NULL", "undefined", "0".repeat(22)]) {
      expect((await getIcs(slug, token)).status, token).toBe(404);
    }
  });

  it("is offered by POST as an icsUrl with a token and no names or times, and following it returns the booking just made", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { venuePostcode: "SW1A 1AA" });
    const res = await Promise.resolve(
      onRequestPost({
        request: new Request(`http://localhost/api/events/${slug}/bookings`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: SLOT, field1: "  Zoë & Co ", field2: "Sam #1 ", idempotencyKey: generateBookingToken() }),
        }),
        env: t.env,
        params: { slug },
      } as unknown as Parameters<typeof onRequestPost>[0]),
    );
    expect(res.status).toBe(201);
    const { icsUrl } = (await res.json()) as { icsUrl: string };
    const stored = await t.env.DB.prepare("SELECT token FROM bookings WHERE event_id = ?").bind(id).first<{ token: string }>();
    expect(stored?.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(icsUrl).toBe(`/api/events/${slug}/bookings/${stored!.token}/ics`);
    // Once the slug and token are removed, nothing but the fixed route skeleton is left: no names, no slot.
    expect(icsUrl.replace(slug, "").replace(stored!.token, "")).toBe("/api/events//bookings//ics");
    const followed = await getIcs(slug, stored!.token);
    expect(followed.status).toBe(200);
    expect(followed.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(vevent(await followed.text()).summary).toContain("Zoë & Co");
  });
});
