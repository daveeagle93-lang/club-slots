import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../../../../../server/env";
import {
  accessClaims, accessEnv, accessJwt, adminApp, jwksFetch, NOW, newAccessKey, ORIGIN, passwordEnv, TEST_PASSWORD,
} from "../../../../../server/auth/test-harness";
import { createTestEnv, insertBooking, insertBookingOf, insertEvent, type TestEnv } from "../../../../../test/db";
import { onRequestGet } from "./export.csv";

const ADMIN = { admin: { identity: "test@example.com", csrfBinding: "x" } };
const BOM = "﻿";
const HEADER = '"Time","Dog","Handler","Booked at"\r\n';

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.dispose(); });

type Handler = (c: unknown) => Response | Promise<Response>;
/** Pass a second argument (even undefined) to replace the admin data. */
const get = (slug: string, ...data: unknown[]): Promise<Response> =>
  Promise.resolve((onRequestGet as unknown as Handler)({
    request: new Request(`http://localhost/api/admin/events/${slug}/export.csv`), env: t.env, params: { slug }, data: data.length > 0 ? data[0] : ADMIN,
  }));

/** Response.text() drops a leading byte order mark; this keeps it so the tests can see it. */
const body = async (res: Response): Promise<string> => new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(await res.arrayBuffer());

const setCreated = (id: number, createdAt: string) =>
  t.env.DB.prepare("UPDATE bookings SET created_at = ? WHERE id = ?").bind(createdAt, id).run();

describe("GET /api/admin/events/[slug]/export.csv", () => {
  it("answers a header row only for an event with no bookings, with the headers a download needs", async () => {
    const { slug } = await insertEvent(t.env.DB);
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${slug}-bookings.csv"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await body(res)).toBe(`${BOM}${HEADER}`);
  });

  it("lists bookings by slot start in London time (BST and GMT), booked-at in London time, whatever the insert order", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { startUtc: "2026-10-24T08:00:00Z", endUtc: "2026-10-24T11:00:00Z" });
    const late = await insertBooking(t.env.DB, id, "2026-10-24T09:00:00Z", "Flo", "Pat Jones");
    const early = await insertBooking(t.env.DB, id, "2026-10-24T08:00:00Z", "Rex", "Sam Smith");
    await setCreated(early, "2026-10-01T22:30:05Z"); // BST: 23:30
    await setCreated(late, "2026-12-01T09:05:00Z"); // GMT: 09:05
    const text = await body(await get(slug));
    expect(text).toBe(
      `${BOM}${HEADER}"2026-10-24 09:00","Rex","Sam Smith","2026-10-01 23:30"\r\n"2026-10-24 10:00","Flo","Pat Jones","2026-12-01 09:05"\r\n`,
    );
  });

  it("has one column for each field of the booking form, headed by its label, in the form's order, with an optional blank as an empty cell", async () => {
    const fields = [{ label: "Rider", identity: true }, { label: "Pony", identity: true }, { label: "Phone", required: false }, { label: "Notes", required: false }];
    const { id, slug } = await insertEvent(t.env.DB, { fields });
    const first = await insertBookingOf(t.env.DB, id, fields, "2026-06-13T08:00:00Z", ["Ann Lee", "Biscuit", "07700 900123", "Nervous, shy"]);
    const second = await insertBookingOf(t.env.DB, id, fields, "2026-06-13T08:15:00Z", ["Bea", "Nutmeg"]);
    await setCreated(first, "2026-06-01T10:00:00Z");
    await setCreated(second, "2026-06-01T10:05:00Z");
    expect(await body(await get(slug))).toBe(
      `${BOM}"Time","Rider","Pony","Phone","Notes","Booked at"\r\n`
      + '"2026-06-13 09:00","Ann Lee","Biscuit","07700 900123","Nervous, shy","2026-06-01 11:00"\r\n'
      + '"2026-06-13 09:15","Bea","Nutmeg","","","2026-06-01 11:05"\r\n',
    );
  });

  it("has a single column for a form of one field, and puts the Lane column before the fields", async () => {
    const one = await insertEvent(t.env.DB, { fields: [{ label: "Car reg", identity: true }], lanes: ["Ring 1", "Ring 2"] });
    expect(await body(await get(one.slug))).toBe(`${BOM}"Time","Lane","Car reg","Booked at"\r\n`);
  });

  it("guards a label that a spreadsheet would run as a formula, like every other cell", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { fields: [{ label: "=SUM(A1)", identity: true }, { label: "+Pony", required: false }] });
    const text = await body(await get(slug));
    expect(text).toBe(`${BOM}"Time","'=SUM(A1)","'+Pony","Booked at"\r\n`);
    await insertBookingOf(t.env.DB, id, [{ label: "=SUM(A1)", identity: true }, { label: "+Pony" }], "2026-06-13T08:00:00Z", ["=1+1", "@x"]);
    expect(await body(await get(slug))).toContain(`"'=1+1","'@x"`);
  });

  it("exports only that event's bookings", async () => {
    const a = await insertEvent(t.env.DB);
    const b = await insertEvent(t.env.DB);
    await insertBooking(t.env.DB, a.id, "2026-06-13T08:00:00Z", "Mine", "Me");
    await insertBooking(t.env.DB, b.id, "2026-06-13T08:00:00Z", "Theirs", "Them");
    const text = await body(await get(a.slug));
    expect(text).toContain("Mine");
    expect(text).not.toContain("Theirs");
  });

  it("protects names that a spreadsheet would run as a formula, and quotes awkward ones", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", '=HYPERLINK("http://x")', "@home");
    await insertBooking(t.env.DB, id, "2026-06-13T08:15:00Z", "Zoë", "Smith, Sam");
    const text = await body(await get(slug));
    expect(text).toContain(`"'=HYPERLINK(""http://x"")","'@home"`);
    expect(text).toContain('"Zoë","Smith, Sam"');
  });

  it("one unnamed lane with several places has no Lane column and lists a time's bookings in place order", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { capacity: 2 });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "Second", "B", { place: 2 });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "First", "A", { place: 1 });
    const rows = (await body(await get(slug))).split("\r\n");
    expect(rows[0]).toBe(`${BOM}${HEADER.trimEnd()}`);
    expect(rows.slice(1, 3).map((r) => r.split(",").slice(0, 3).join(","))).toEqual(['"2026-06-13 09:00","First","A"', '"2026-06-13 09:00","Second","B"']);
  });

  it("adds a Lane column after Time when a lane is named (a single named lane too), sorted by time, lane order, then place", async () => {
    const { id, slug, laneIds } = await insertEvent(t.env.DB, { capacity: 2, lanes: ["Ring B", "Ring A"] });
    await insertBooking(t.env.DB, id, "2026-06-13T08:15:00Z", "Late", "L", { laneId: laneIds[0], place: 1 });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "R2P1", "H", { laneId: laneIds[1], place: 1 });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "R1P2", "H", { laneId: laneIds[0], place: 2 });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "R1P1", "H", { laneId: laneIds[0], place: 1 });
    const rows = (await body(await get(slug))).split("\r\n");
    expect(rows[0]).toBe(`${BOM}"Time","Lane","Dog","Handler","Booked at"`);
    expect(rows.slice(1, 5).map((r) => r.split(",").slice(0, 4).join(","))).toEqual([
      '"2026-06-13 09:00","Ring B","R1P1","H"', '"2026-06-13 09:00","Ring B","R1P2","H"',
      '"2026-06-13 09:00","Ring A","R2P1","H"', '"2026-06-13 09:15","Ring B","Late","L"',
    ]);
    expect(rows.at(-1)).toBe("");

    const single = await insertEvent(t.env.DB, { lanes: ["Only ring"] });
    await insertBooking(t.env.DB, single.id, "2026-06-13T08:00:00Z", "Rex", "Sam");
    const text = await body(await get(single.slug));
    expect(text.startsWith(`${BOM}"Time","Lane","Dog","Handler","Booked at"\r\n"2026-06-13 09:00","Only ring","Rex","Sam",`)).toBe(true);
  });

  it("protects lane names a spreadsheet would run as a formula, like every other cell", async () => {
    const { id, slug, laneIds } = await insertEvent(t.env.DB, { lanes: ["=1+1", "@x", '+SUM(A1)', "Plain, \"quoted\""] });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "A", "H", { laneId: laneIds[0] });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "B", "H", { laneId: laneIds[1] });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "C", "H", { laneId: laneIds[2] });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "D", "H", { laneId: laneIds[3] });
    const text = await body(await get(slug));
    expect(text).toContain(`"2026-06-13 09:00","'=1+1","A"`);
    expect(text).toContain(`"2026-06-13 09:00","'@x","B"`);
    expect(text).toContain(`"2026-06-13 09:00","'+SUM(A1)","C"`);
    expect(text).toContain(`"2026-06-13 09:00","Plain, ""quoted""","D"`);
    expect(text).not.toMatch(/"=1\+1"|"@x"/);
  });

  it("works for an archived event", async () => {
    const { id, slug } = await insertEvent(t.env.DB, { archived: true });
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "Rex", "Sam");
    const res = await get(slug);
    expect(res.status).toBe(200);
    expect(await body(res)).toContain('"Rex","Sam"');
  });

  it("answers 404 JSON, no-store, for an unknown slug and for a malformed one", async () => {
    for (const slug of ["AbCdEfGhIjKlMnOpQrStUv", "short", 'x"; y=1']) {
      const res = await get(slug);
      expect(res.status, slug).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("only ever puts a slug of letters, digits, hyphens and underscores in the filename", async () => {
    // A slug outside that set never reaches the header: it is a 404 with no Content-Disposition.
    const res = await get('abc"\r\nSet-Cookie: x=1;AAAAAAAAAAAAAAAA');
    expect(res.status).toBe(404);
    expect(res.headers.get("content-disposition")).toBeNull();
    const { slug } = await insertEvent(t.env.DB);
    expect((await get(slug)).headers.get("content-disposition")).toMatch(/^attachment; filename="[A-Za-z0-9_-]+-bookings\.csv"$/);
  });

  it("answers 401 and no data when the guard set no admin", async () => {
    const { id, slug } = await insertEvent(t.env.DB);
    await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "Rex", "Sam");
    for (const data of [undefined, {}, { admin: null }, { admin: { identity: "" } }]) {
      const res = await get(slug, data);
      expect(res.status, JSON.stringify(data)).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).not.toContain("text/csv");
      expect(await body(res)).not.toContain("Rex");
    }
  });

  it("answers 500 JSON, not a partial file, when the database fails", async () => {
    const { slug } = await insertEvent(t.env.DB);
    const broken = { DB: { prepare: () => { throw new Error("boom"); } } };
    const res = await Promise.resolve((onRequestGet as unknown as Handler)({
      request: new Request("http://localhost/x"), env: broken, params: { slug }, data: ADMIN,
    }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).not.toContain("text/csv");
  });
});

describe("behind the admin guard", () => {
  const routes = (context: { request: Request }): Response | Promise<Response> | undefined => {
    const m = /^\/api\/admin\/events\/([^/]+)\/export\.csv$/.exec(new URL(context.request.url).pathname);
    return m ? (onRequestGet as unknown as Handler)({ ...context, params: { slug: m[1] } }) : undefined;
  };

  async function password() {
    const env = await passwordEnv(t.env.DB);
    const app = adminApp({ now: () => NOW }, routes);
    const login = await app(env, "/api/admin/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.201" },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(login.status).toBe(200);
    return { env, app, auth: { Cookie: login.headers.get("set-cookie")!.split(";")[0] } };
  }

  async function access() {
    const key = await newAccessKey("kid-1");
    const env = accessEnv(t.env.DB);
    const app = adminApp({ now: () => NOW, fetch: jwksFetch(() => [key]) as unknown as typeof fetch }, routes);
    return { env, app, auth: { "Cf-Access-Jwt-Assertion": await accessJwt(key, accessClaims()) } };
  }

  describe.each([["password", password], ["access", access]] as const)("with the %s provider", (_name, make) => {
    it("is 401 with no session, with no CSV in the body", async () => {
      const { slug, id } = await insertEvent(t.env.DB);
      await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "SecretDog", "Sam");
      const { env, app } = await make();
      const res = await app(env, `/api/admin/events/${slug}/export.csv`);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).not.toContain("text/csv");
      expect(await body(res)).not.toContain("SecretDog");
    });

    it("is 200 with the CSV for a signed-in admin on a plain GET (no CSRF token needed)", async () => {
      const { slug, id } = await insertEvent(t.env.DB);
      await insertBooking(t.env.DB, id, "2026-06-13T08:00:00Z", "Rex", "Sam");
      const { env, app, auth } = await make();
      const res = await app(env, `/api/admin/events/${slug}/export.csv`, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(await body(res)).toContain('"2026-06-13 09:00","Rex","Sam"');
    });

    it("is 404 for an unknown slug once signed in", async () => {
      const { env, app, auth } = await make();
      const res = await app(env, "/api/admin/events/AbCdEfGhIjKlMnOpQrStUv/export.csv", { headers: auth });
      expect(res.status).toBe(404);
    });

    it("is 503 when admin auth is not configured", async () => {
      const { slug } = await insertEvent(t.env.DB);
      const { env, app, auth } = await make();
      const res = await app({ ...(env as AppEnv), ADMIN_AUTH: "" }, `/api/admin/events/${slug}/export.csv`, { headers: auth });
      expect(res.status).toBe(503);
    });
  });
});
