// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPrivacyNotice } from "../src/server/config";
import { init } from "./booking.js";

const SLUG = "abcdefghijklmnop";
const DOG_HANDLER = [{ position: 1, label: "Dog", required: true, maxLength: 80 }, { position: 2, label: "Handler", required: true, maxLength: 80 }];
const EVENT = {
  slug: SLUG, name: "Trial Day", startUtc: "2026-06-13T08:00:00Z", endUtc: "2026-06-13T15:00:00Z",
  costPence: 1500, venuePostcode: "SW1A 1AA", details: "Bring water.\nBe kind.", archived: false, fields: DOG_HANDLER,
};
const PRIVACY = defaultPrivacyNotice(["Dog", "Handler"]);
/** The booking as the server answers for the Dog and Handler form: each value under its label. */
const dogHandler = (dog: string, handler: string) => [{ label: "Dog", value: dog }, { label: "Handler", value: handler }];
const slot = (start: string, end: string, status: "free" | "taken" | "past" = "free") => ({ start, end, status });
const SLOTS = [
  slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "taken"),
  slot("2026-06-13T08:20:00Z", "2026-06-13T08:35:00Z"),
  slot("2026-06-13T08:40:00Z", "2026-06-13T08:55:00Z"),
  slot("2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z"),
];
const ICS_URL = "/api/events/abc/bookings/tok0123456789abcdef01/ics";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const OPEN = { open: true, closesAt: "2026-06-13T08:00:00Z" };
const getOk = (event = EVENT, slots: unknown[] = SLOTS, extra: Record<string, unknown> = {}) =>
  reply(200, { event, slots, bookings: OPEN, privacyNotice: PRIVACY, ...extra });
const created = () => reply(201, {
  booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: dogHandler("Biscuit", "Ann Lee") },
  event: EVENT, icsUrl: ICS_URL,
});

type Call = { url: string; init?: RequestInit };
type Handler = (call: Call) => Response | Promise<Response>;

async function start(handler: Handler, pathname = `/e/${SLUG}`, settings?: unknown, settingsTimeoutMs?: number) {
  document.body.innerHTML = '<main id="app"></main>';
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  });
  const clipboard = { writeText: vi.fn(async () => {}) };
  await init({
    document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname }, clipboard,
    settings: (settings === undefined ? null : Promise.resolve(settings)) as never,
    ...(settingsTimeoutMs === undefined ? {} : { settingsTimeoutMs }),
  });
  return { calls, clipboard };
}

const routes = (post: Handler, get: Handler = () => getOk()): Handler => (call) =>
  call.init?.method === "POST" ? post(call) : get(call);

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const slotButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".slot-grid button")];
const slotButton = (time: string) => slotButtons().find((b) => b.textContent!.startsWith(time))!;
const form = () => $("#booking-form") as HTMLFormElement;
const type = (sel: string, value: string) => {
  const input = $(sel) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = () => form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const fill = (dog = "Biscuit", handler = "Ann Lee") => {
  type("#field-1", dog);
  type("#field-2", handler);
};
const text = () => document.body.textContent ?? "";

beforeEach(() => {
  // scrollIntoView is not implemented by happy-dom
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("loading and slots", () => {
  it("fetches the event uncached and renders free slots only", async () => {
    const { calls } = await start(routes(() => created()));
    expect(calls[0].url).toBe(`/api/events/${SLUG}`);
    expect(calls[0].init?.cache).toBe("no-store");
    expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40", "10:00"]);
    expect(slotButton("09:20").getAttribute("aria-label")).toBe("Book 09:20 slot");
    expect(text()).toContain("3 slots left");
  });

  it("renders the event header in London time", async () => {
    await start(routes(() => created()));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("09:00–16:00");
    expect(text()).toContain("£15.00");
    const maps = document.querySelector<HTMLAnchorElement>("a[href^='https://www.google.com/maps/']")!;
    expect(maps.textContent).toBe("SW1A 1AA");
    expect(maps.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=SW1A%201AA");
    expect(maps.getAttribute("target")).toBe("_blank");
    expect(maps.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says fully booked when nothing is free", async () => {
    await start(routes(() => created(), () => getOk(EVENT, [SLOTS[0]])));
    expect(slotButtons()).toHaveLength(0);
    expect(text()).toContain("Fully booked");
  });

  describe("slots that have already started", () => {
    const WITH_PAST = [
      slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "past"),
      slot("2026-06-13T08:20:00Z", "2026-06-13T08:35:00Z", "taken"),
      slot("2026-06-13T08:40:00Z", "2026-06-13T08:55:00Z"),
      slot("2026-06-13T09:00:00Z", "2026-06-13T09:15:00Z"),
    ];

    it("renders them disabled, labelled Started, and not selectable", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST)));
      expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "09:40", "10:00"]);
      const past = slotButton("09:00");
      expect(past.querySelector(".slot-time")!.textContent).toBe("09:00");
      expect(past.querySelector(".slot-note")!.textContent).toBe("Started");
      expect(past.disabled).toBe(true);
      expect(past.classList.contains("past")).toBe(true);
      expect(past.getAttribute("aria-label")).toBe("09:00 slot, started");
      expect(past.hasAttribute("aria-pressed")).toBe(false);
      past.click();
      expect(form().hidden).toBe(true);
      expect(slotButton("09:40").disabled).toBe(false);
      expect(slotButton("09:40").classList.contains("past")).toBe(false);
    });

    it("counts only bookable slots in the slots-left text", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST)));
      expect(text()).toContain("2 slots left");
    });

    it("says fully booked when only started and taken slots remain", async () => {
      await start(routes(() => created(), () => getOk(EVENT, WITH_PAST.slice(0, 2))));
      expect(text()).toContain("Fully booked");
      expect(slotButtons().every((b) => b.disabled)).toBe(true);
    });
  });

  it("shows the form only after a slot is picked", async () => {
    await start(routes(() => created()));
    expect(form().hidden).toBe(true);
    slotButton("09:40").click();
    expect(form().hidden).toBe(false);
    expect(slotButton("09:40").getAttribute("aria-pressed")).toBe("true");
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("false");
    expect(form().textContent).toContain("Booking 09:40");
    expect(form().querySelector("button[type=submit]")!.textContent).toBe("Confirm booking for 09:40");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe("closed and missing events", () => {
  it("shows not-found for a 404", async () => {
    await start(() => reply(404, { error: { code: "not_found", message: "Event not found" } }));
    expect(text()).toContain("We couldn't find that event. Check the link you were sent.");
    expect(document.querySelector(".slot-grid")).toBeNull();
  });

  it("shows not-found without calling the API for a bad path", async () => {
    const { calls } = await start(() => getOk(), "/e/");
    expect(calls).toHaveLength(0);
    expect(text()).toContain("We couldn't find that event.");
  });

  it("shows the header and a closed message for archived events", async () => {
    await start(() => getOk({ ...EVENT, archived: true }, []));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Bookings for this event are closed.");
    expect(document.querySelector("form")).toBeNull();
  });

  it("shows the header and a Bookings closed message, not the form or slots, once the cut-off has passed", async () => {
    await start(() => getOk(EVENT, SLOTS, { bookings: { open: false, closesAt: "2026-06-13T08:00:00Z" } }));
    expect($("h1").textContent).toBe("Trial Day");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("£15.00");
    expect($(".message h2").textContent).toBe("Bookings closed");
    expect(text()).toContain("Bookings for this event are closed.");
    expect(document.querySelector("form")).toBeNull();
    expect(slotButtons()).toHaveLength(0);
    expect(document.querySelector(".privacy")).toBeNull();
  });

  it("offers retry after a network error", async () => {
    let fail = true;
    await start(() => {
      if (fail) throw new TypeError("offline");
      return getOk();
    });
    expect(slotButtons()).toHaveLength(0);
    fail = false;
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.click();
    await vi.waitFor(() => expect(slotButtons()).toHaveLength(3));
  });
});

describe("booking", () => {
  it("posts the booking and shows the confirmation", async () => {
    const { calls } = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));

    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(post.url).toBe(`/api/events/${SLUG}/bookings`);
    expect((post.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(post.init!.body as string)).toEqual({
      slot: SLOTS[1].start, field1: "Biscuit", field2: "Ann Lee", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });

    expect(text()).toContain("Biscuit");
    expect(text()).toContain("Ann Lee");
    expect(text()).toContain("09:20");
    expect(text()).toContain("Saturday 13 June 2026");
    expect(text()).toContain("SW1A 1AA");
    expect(text()).toContain("£15.00");
    expect(text()).toContain("Bring water.");
    const cal = [...document.querySelectorAll("a")].find((a) => a.textContent === "Add to calendar")!;
    expect(cal.getAttribute("href")).toBe(ICS_URL);
    expect(cal.hasAttribute("download")).toBe(false);
    expect(slotButtons()).toHaveLength(0);
  });

  it("sends names as typed", async () => {
    const { calls } = await start(routes(() => created()));
    slotButton("09:20").click();
    fill("  Biscuit ", "ann  lee");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    const body = JSON.parse(calls.find((c) => c.init?.method === "POST")!.init!.body as string);
    expect(body.field1).toBe("  Biscuit ");
    expect(body.field2).toBe("ann  lee");
  });

  it("disables the button while pending and never double-posts", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => { resolve = r; });
    const { calls } = await start(routes(() => pending));
    slotButton("09:20").click();
    fill();
    submit();
    submit();
    const button = form().querySelector("button[type=submit]") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect($(".progress").textContent).toBe("Confirming your booking…");
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    resolve(created());
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
  });

  // The page after another booker took 09:20 and 09:40: only 10:00 is left, and 09:00 London (started) is still listed.
  const AFTER = [
    slot("2026-06-13T08:00:00Z", "2026-06-13T08:15:00Z", "past"),
    slot(SLOTS[1].start, SLOTS[1].end, "taken"),
    slot(SLOTS[2].start, SLOTS[2].end, "taken"),
    SLOTS[3],
  ];
  const BEFORE = [AFTER[0], SLOTS[1], SLOTS[2], SLOTS[3]];
  const afterGet = () => { let gets = 0; return () => (gets++ === 0 ? getOk(EVENT, BEFORE) : getOk(EVENT, AFTER)); };

  it("refetches the event after a slot_taken 409, notices, and keeps the typed names", async () => {
    const freeSlots = [{ start: SLOTS[3].start, end: SLOTS[3].end }];
    const { calls } = await start(routes(() => reply(409, {
      error: { code: "slot_taken", message: "That slot's just gone." }, freeSlots,
    }), afterGet()));
    slotButton("09:20").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That slot's just gone."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "10:00"]));

    expect($("#notice").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe($("#notice"));
    expect(slotButton("09:00").disabled).toBe(true);
    expect(slotButtons()[1].getAttribute("aria-pressed")).toBe("false");
    expect(text()).toContain("1 slot left");
    expect(form().hidden).toBe(true);
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#field-2") as HTMLInputElement).value).toBe("Ann Lee");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2); // the load, then the refetch

    slotButton("10:00").click();
    expect(form().hidden).toBe(false);
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
  });

  it("handles slot_started like slot_taken: refetches, keeps the started slots, its own message, typed names kept", async () => {
    const freeSlots = [{ start: SLOTS[3].start, end: SLOTS[3].end }];
    const { calls } = await start(routes(() => reply(409, {
      error: { code: "slot_started", message: "That session has already started." }, freeSlots,
    }), afterGet()));
    slotButton("09:20").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That session has already started."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:00Started", "10:00"]));

    expect($("#notice").getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe($("#notice"));
    expect(text()).toContain("1 slot left");
    expect(form().hidden).toBe(true);
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#field-2") as HTMLInputElement).value).toBe("Ann Lee");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
  });

  it("falls back to the 409 payload's free slots when the refetch fails", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [{ start: SLOTS[3].start, end: SLOTS[3].end }] }),
      () => (gets++ === 0 ? getOk() : reply(500, { error: { code: "internal_error" } })),
    ));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["10:00"]));
    expect($("#notice").textContent).toContain("That slot's just gone.");
    expect(document.activeElement).toBe($("#notice"));
  });

  it("shows the closed message when the refetch after a 409 finds the event closed", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] }),
      () => (gets++ === 0 ? getOk() : reply(200, { event: EVENT, slots: [], bookings: { open: false } })),
    ));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
  });

  it("shows fully booked when the refetched event has no free slots", async () => {
    let gets = 0;
    await start(routes(
      () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0]])),
    ));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons()).toHaveLength(0));
    expect(text()).toContain("Fully booked");
  });

  it("shows the duplicate_booking message and keeps inputs and selection", async () => {
    await start(routes(() => reply(409, {
      error: { code: "duplicate_booking", message: "That dog and handler already have a booking for this event." },
    })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("already have a booking"));
    expect(form().hidden).toBe(false);
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("true");
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    expect((form().querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows field errors for invalid_input", async () => {
    await start(routes(() => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { field1: "Dog is required." },
    })));
    slotButton("09:20").click();
    fill("Biscuit", "Ann");
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Dog is required."));
    const dog = $("#field-1");
    expect(dog.getAttribute("aria-invalid")).toBe("true");
    const err = document.getElementById(dog.getAttribute("aria-describedby")!.split(" ")[0])!;
    expect(err.textContent).toBe("Dog is required.");
    expect($("#field-2").getAttribute("aria-invalid")).not.toBe("true");
  });

  it("refetches on invalid_slot", async () => {
    let gets = 0;
    const { calls } = await start(routes(
      () => reply(400, { error: { code: "invalid_slot", message: "x" } }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[1], SLOTS[2]])),
    ));
    slotButton("10:00").click();
    fill();
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40"]));
    expect($("#notice").textContent).toContain("That slot isn't available any more.");
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
    expect(form().hidden).toBe(true);
  });

  it("refetches on event_changed, notices, keeps the typed names and focuses the notice", async () => {
    let gets = 0;
    const { calls } = await start(routes(
      () => reply(409, { error: { code: "event_changed", message: "x" } }),
      () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[1], SLOTS[2]])),
    ));
    slotButton("10:00").click();
    fill("Biscuit", "Ann Lee");
    submit();
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["09:20", "09:40"]));
    expect($("#notice").textContent).toContain("The event was just changed. The times below are up to date; choose again.");
    expect(text()).not.toContain("Something went wrong");
    expect(document.activeElement).toBe($("#notice"));
    expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
    expect(form().hidden).toBe(true);
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    expect(($("#field-2") as HTMLInputElement).value).toBe("Ann Lee");
  });

  describe("when the booking form's fields were changed meanwhile", () => {
    const NEW_FIELDS = [
      { position: 1, label: "Dog", required: true, maxLength: 80 }, { position: 2, label: "Owner", required: true, maxLength: 40 },
      { position: 3, label: "Phone", required: false, maxLength: 20 },
    ];
    const NEW_EVENT = { ...EVENT, fields: NEW_FIELDS };
    const NEW_PRIVACY = defaultPrivacyNotice(["Dog", "Owner", "Phone"]);
    const CHANGED = "The event was just changed. The times below are up to date; choose again.";
    const changedAfter = (answer: Handler) => {
      let gets = 0;
      return start(routes(answer, () => (gets++ === 0 ? getOk() : getOk(NEW_EVENT, SLOTS, { privacyNotice: NEW_PRIVACY }))));
    };

    it("rebuilds the form from the fresh fields on a refetch, keeping what was typed where the label is the same, and says the event changed", async () => {
      await changedAfter(() => reply(409, { error: { code: "event_changed", message: "x" } }));
      slotButton("09:20").click();
      fill("Biscuit", "Ann Lee");
      submit();
      await vi.waitFor(() => expect(document.querySelectorAll("#booking-form .field")).toHaveLength(3));
      expect([...document.querySelectorAll("#booking-form .field label")].map((l) => l.textContent)).toEqual(["Dog", "Owner", "Phone (optional)"]);
      expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit"); // same label: kept
      expect(($("#field-2") as HTMLInputElement).value).toBe(""); // Handler became Owner: not carried over
      expect(($("#field-2") as HTMLInputElement).maxLength).toBe(40);
      expect(($("#field-3") as HTMLInputElement).required).toBe(false);
      expect($("#notice").textContent).toBe(CHANGED);
      expect(form().hidden).toBe(true);
      expect(document.activeElement).toBe($("#notice"));
      expect($(".privacy").textContent).toContain("Owner");
      // The rebuilt form is the live one: it posts all three.
      slotButton("09:20").click();
      expect(form().hidden).toBe(false);
    });

    it("posts the values of the rebuilt form", async () => {
      let n = 0;
      const { calls } = await changedAfter(() => (++n === 1 ? reply(409, { error: { code: "event_changed", message: "x" } }) : created()));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect(document.querySelectorAll("#booking-form .field")).toHaveLength(3));
      slotButton("09:20").click();
      type("#field-2", "Ann Lee");
      type("#field-3", "07700 900123");
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      const posts = calls.filter((c) => c.init?.method === "POST");
      expect(JSON.parse(String(posts[1].init!.body))).toMatchObject({ field1: "Biscuit", field2: "Ann Lee", field3: "07700 900123" });
    });

    it("treats an error for a field the page has no input for as a changed event, rather than showing nothing highlighted", async () => {
      await changedAfter(() => reply(400, {
        error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { field3: "Phone is required." },
      }));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect(document.querySelectorAll("#booking-form .field")).toHaveLength(3));
      expect($("#notice").textContent).toBe(CHANGED);
      expect($(".form-error").textContent).toBe("");
      expect(form().hidden).toBe(true);
      expect(document.activeElement).toBe($("#notice"));
    });

    it("still shows the errors it can place when another is for a field the page has no input for", async () => {
      await changedAfter(() => reply(400, {
        error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { field1: "Dog is required.", field3: "Phone is required." },
      }));
      slotButton("09:20").click();
      submit();
      await vi.waitFor(() => expect($("#field-1-error").textContent).toBe("Dog is required."));
      expect(document.querySelectorAll("#booking-form .field")).toHaveLength(2);
      expect(form().hidden).toBe(false);
    });

    it("leaves the form and the typed values alone when the fields are the same", async () => {
      let gets = 0;
      await start(routes(() => reply(409, { error: { code: "event_changed", message: "x" } }), () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[1]]))));
      const before = form();
      slotButton("09:20").click();
      fill("Biscuit", "Ann Lee");
      submit();
      await vi.waitFor(() => expect(slotButtons()).toHaveLength(1));
      expect(form()).toBe(before);
    });
  });

  it.each(["event_archived", "bookings_closed"])("switches to the closed state on 410 %s", async (code) => {
    await start(routes(() => reply(410, { error: { code, message: "closed" } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
    expect($(".message h2").textContent).toBe("Bookings closed");
    expect(document.querySelector("form")).toBeNull();
    expect(slotButtons()).toHaveLength(0);
  });

  it("shows the server's message when the idempotency key was reused with different details", async () => {
    const message = "That request doesn't match the earlier one. Reload the page and try again.";
    await start(routes(() => reply(422, { error: { code: "idempotency_key_reuse", message } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain(message));
    expect(form().hidden).toBe(false);
  });

  describe("a key reused with a different payload", () => {
    const original = {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: dogHandler("Biscuit", "Ann Leee") },
      event: EVENT, icsUrl: ICS_URL,
    };
    const reuse = { error: { code: "idempotency_key_reuse", message: "An earlier attempt was saved." } };

    it("after a lost response and a corrected name, shows the confirmation of the ORIGINAL booking with a notice", async () => {
      let attempts = 0;
      const { calls } = await start(routes(() => {
        if (attempts++ === 0) throw new TypeError("offline"); // the booking was saved, but the response was lost
        return reply(422, { ...reuse, ...original });
      }));
      slotButton("09:20").click();
      fill("Biscuit", "Ann Leee");
      submit();
      await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
      fill("Biscuit", "Ann Lee"); // the corrected name
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));

      expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
      expect(JSON.parse(calls.filter((c) => c.init?.method === "POST")[1].init!.body as string).field2).toBe("Ann Lee");
      const handlerRow = [...document.querySelectorAll("dt")].find((dt) => dt.textContent === "Handler")!;
      expect(handlerRow.nextElementSibling!.textContent).toBe("Ann Leee"); // as stored, not as retyped
      expect(text()).toContain("09:20");
      const cal = [...document.querySelectorAll("a")].find((a) => a.textContent === "Add to calendar")!;
      expect(cal.getAttribute("href")).toBe(ICS_URL);
      expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Copy booking")).toBe(true);
      const notice = $("[role=status]");
      expect(notice.textContent).toBe(
        "We'd already saved a booking from this page, so we haven't changed it. Here it is. To change it, contact the organiser.",
      );
      expect(notice.compareDocumentPosition($("h1")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.activeElement).toBe($("h1"));
      expect(document.querySelector("form")).toBeNull();
    });

    it("shows no notice on an ordinary confirmation", async () => {
      await start(routes(() => created()));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(document.querySelector("[role=status]")).toBeNull();
    });

    it("renders the notice and the original booking as text", async () => {
      const evil = "<img src=x onerror=alert(1)>";
      await start(routes(() => reply(422, { ...reuse, ...original, booking: { ...original.booking, fields: dogHandler(evil, "Ann Leee") } })));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(document.querySelector("img")).toBeNull();
      expect(text()).toContain(evil);
    });
  });

  it("shows the server's text as the form error when the only field error is the idempotency key", async () => {
    await start(routes(() => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { idempotencyKey: "Reload the page and try again." },
    })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Reload the page and try again."));
    expect(form().textContent).not.toContain("Check the highlighted fields.");
  });

  it.each([
    ["a server error", () => reply(500, { error: { code: "internal_error", message: "boom" } })],
    ["a network error", () => { throw new TypeError("offline"); }],
  ])("keeps everything after %s", async (_name, fail) => {
    const { calls } = await start(routes(fail as Handler));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    expect(form().hidden).toBe(false);
    expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("true");
    const button = form().querySelector("button[type=submit]") as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    submit(); // can retry
    await vi.waitFor(() => expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2));
  });
});

describe("idempotency key", () => {
  const posts = (calls: Call[]) => calls.filter((c) => c.init?.method === "POST");
  const keyOf = (c: Call) => JSON.parse(c.init!.body as string).idempotencyKey as string;

  it("reuses one key when a submit is retried after a network error", async () => {
    let fail = true;
    const { calls } = await start(routes(() => {
      if (fail) throw new TypeError("offline");
      return created();
    }));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    fail = false;
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(posts(calls)).toHaveLength(2);
    expect(keyOf(posts(calls)[0])).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("reuses it after a server error", async () => {
    let status = 500;
    const { calls } = await start(routes(() => (status === 500 ? reply(500, { error: { code: "internal_error", message: "x" } }) : created())));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Something went wrong. Please try again."));
    status = 201;
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("reuses it for another slot after a slot_taken 409", async () => {
    let taken = true;
    let gets = 0;
    const { calls } = await start(routes(() => (taken
      ? reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [{ start: SLOTS[3].start, end: SLOTS[3].end }] })
      : created()), () => (gets++ === 0 ? getOk() : getOk(EVENT, [SLOTS[0], SLOTS[3]]))));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("#notice").textContent).toContain("That slot's just gone."));
    await vi.waitFor(() => expect(slotButtons().map((b) => b.textContent)).toEqual(["10:00"]));
    taken = false;
    slotButton("10:00").click();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(JSON.parse(posts(calls)[1].init!.body as string).slot).toBe(SLOTS[3].start);
    expect(keyOf(posts(calls)[1])).toBe(keyOf(posts(calls)[0]));
  });

  it("uses a different key in a new page session after a successful booking", async () => {
    const first = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    const second = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(keyOf(posts(second.calls)[0])).not.toBe(keyOf(posts(first.calls)[0]));
  });
});

describe("privacy notice", () => {
  const heading = () => [...document.querySelectorAll("h3")].find((h) => h.textContent === "Privacy")!;

  it("shows the server's notice under a Privacy heading, before the submit button", async () => {
    await start(routes(() => created()));
    slotButton("09:20").click();
    expect(heading().closest("form")).toBe(form());
    expect(heading().parentElement!.textContent).toContain(PRIVACY);
    const submitButton = form().querySelector("button[type=submit]")!;
    expect(heading().compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("splits paragraphs on blank lines", async () => {
    await start(routes(() => created(), () => getOk(EVENT, SLOTS, { privacyNotice: "First.\n\nSecond.\nStill second." })));
    expect([...heading().parentElement!.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["First.", "Second.\nStill second."]);
  });

  it("renders markup in the notice as inert text", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await start(routes(() => created(), () => getOk(EVENT, SLOTS, { privacyNotice: `${evil}\n\n<b>bold</b>` })));
    expect(document.querySelector("img, b, script")).toBeNull();
    expect(heading().parentElement!.textContent).toContain(evil);
    expect(heading().parentElement!.textContent).toContain("<b>bold</b>");
  });
});

describe("confirmation actions", () => {
  async function confirmed() {
    const ctx = await start(routes(() => created()));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    return ctx;
  }
  const copyButton = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy booking")!;

  it("copies a plain-text summary and reverts the confirmation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clipboard } = await confirmed();
    copyButton().click();
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Copied"));
    expect(clipboard.writeText).toHaveBeenCalledWith(
      "Trial Day\nSaturday 13 June 2026, 09:20–09:35\nDog: Biscuit\nHandler: Ann Lee\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind.",
    );
    vi.advanceTimersByTime(2100);
    expect(document.querySelector("[aria-live]")!.textContent).toBe("");
  });

  it("falls back to execCommand when the clipboard API is unavailable", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    const calls: Call[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return init?.method === "POST" ? created() : getOk();
    };
    await init({ document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname: `/e/${SLUG}` }, clipboard: undefined });
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    copyButton().click();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("textarea")).toBeNull(); // temporary textarea removed
    await vi.waitFor(() => expect(document.querySelector("[aria-live]")!.textContent).toBe("Copied"));
  });
});

describe("text safety", () => {
  const evil = "<img src=x onerror=alert(1)>";

  it("renders event fields as text", async () => {
    await start(routes(() => created(), () => getOk({
      ...EVENT, name: evil, details: "<b>bold</b>\n<script>alert(1)</script>", venuePostcode: "<i>x</i>",
    })));
    expect(document.querySelector("img, b, i, script")).toBeNull();
    expect($("h1").textContent).toBe(evil);
    expect(text()).toContain("<b>bold</b>");
    expect(text()).toContain("<script>alert(1)</script>");
  });

  it("renders names and details in the confirmation as text", async () => {
    await start(routes(() => reply(201, {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: dogHandler(evil, "<u>me</u>") },
      event: { ...EVENT, details: "<b>hi</b>" }, icsUrl: ICS_URL,
    })));
    slotButton("09:20").click();
    fill(evil, "<u>me</u>");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(document.querySelector("img, b, u, script")).toBeNull();
    expect(text()).toContain(evil);
    expect(text()).toContain("<b>hi</b>");
  });

  it("renders server messages as text", async () => {
    await start(routes(() => reply(409, { error: { code: "duplicate_booking", message: evil } })));
    slotButton("09:20").click();
    fill();
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain(evil));
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("branding, privacy contact and the admin notice", () => {
  const SETTINGS = {
    clubName: "Barkside Agility", website: null, logo: null, loaded: true,
    privacyContact: { name: "Ann Lee", email: "ann@barkside.example" },
  };
  const SESSION = "/api/admin/session";
  /** What GET /api/admin/session really answers for a signed-in admin. */
  const SIGNED_IN = { identity: "ann@example.com", provider: "password", csrfToken: "tok" };
  const withSettings = (over: Record<string, unknown> = {}) => ({ ...SETTINGS, ...over });
  const probes = (calls: Call[]) => calls.filter((c) => c.url === SESSION);
  /** Event requests get the event, the session probe gets `session`. */
  const route = (session: Handler = () => reply(401, {})): Handler => (call) => (call.url === SESSION ? session(call) : getOk());
  const banner = () => [...document.querySelectorAll(".notice")].find((n) => n.textContent!.startsWith("Admin notice"));

  it("titles the page '<event> – <club>' and adds the header", async () => {
    await start(route(), `/e/${SLUG}`, SETTINGS);
    expect(document.title).toBe("Trial Day – Barkside Agility");
    expect(document.querySelector(".site-header a")!.textContent).toBe("Barkside Agility");
    expect(document.querySelector(".site-header a")!.getAttribute("href")).toBe("/");
  });

  it("titles the page with the event name alone when no club name is set", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ clubName: null }));
    expect(document.title).toBe("Trial Day");
  });

  it("shows the privacy contact after the notice, with a mailto link", async () => {
    await start(route(), `/e/${SLUG}`, SETTINGS);
    const paragraphs = [...document.querySelectorAll(".privacy p")];
    const last = paragraphs[paragraphs.length - 1];
    expect(last.textContent).toBe("Questions about your details, or want them deleted? Contact Ann Lee, ann@barkside.example.");
    expect(paragraphs.length).toBeGreaterThan(1);
    const a = last.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("mailto:ann@barkside.example");
    expect(a.textContent).toBe("ann@barkside.example");
  });

  it("leaves the name out when it is empty", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: { name: "", email: "ann@barkside.example" } }));
    expect(document.querySelector(".privacy p:last-child")!.textContent)
      .toBe("Questions about your details, or want them deleted? Contact ann@barkside.example.");
  });

  it("omits the contact when none is set", async () => {
    await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(text()).not.toContain("Questions about your details");
    expect(document.querySelector(".privacy a")).toBeNull();
  });

  it("builds the mailto link safely from a hostile address", async () => {
    for (const email of ['a@b.c?cc=x&body=y', 'a"@b.c', "a@b.c><img src=x onerror=alert(1)>"]) {
      await start(route(), `/e/${SLUG}`, withSettings({ privacyContact: { name: "", email } }));
      const a = document.querySelector<HTMLAnchorElement>(".privacy a")!;
      const href = a.getAttribute("href")!;
      expect(href, email).toMatch(/^mailto:[^?&"<>\s]*$/);
      expect(decodeURIComponent(href.slice("mailto:".length))).toBe(email);
      expect(a.textContent).toBe(email);
      expect(document.querySelector(".privacy img")).toBeNull();
    }
  });

  it("shows the admin notice, with a link to Settings, when the contact is missing and the probe answers 200", async () => {
    const { calls } = await start(route(() => reply(200, SIGNED_IN)), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(probes(calls)[0].init).toEqual({ credentials: "same-origin", cache: "no-store" });
    expect(banner()!.textContent).toBe(
      "Admin notice (the people booking can't see this): no privacy contact is set, so bookers aren't told who to contact "
      + "about their details. Set one in Settings.",
    );
    expect(banner()!.querySelector("a")!.getAttribute("href")).toBe("/admin/settings");
    expect(document.querySelector("#app")!.firstElementChild).toBe(banner());
  });

  it("keeps the admin notice through later renders", async () => {
    await start(route(() => reply(200, SIGNED_IN)), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    slotButton("09:20").click();
    expect(banner()).toBeDefined();
    expect(document.querySelectorAll(".notice").length).toBeGreaterThan(1); // the booking notice (hidden) and the admin one
    expect(document.querySelector("#app")!.firstElementChild).toBe(banner());
  });

  it("shows nothing when the probe answers 401", async () => {
    const { calls } = await start(route(() => reply(401, {})), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(banner()).toBeUndefined();
  });

  it("shows nothing, and still renders the page, when the probe fails", async () => {
    const { calls } = await start(route(() => { throw new TypeError("blocked by CSP"); }), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(banner()).toBeUndefined();
    expect(slotButtons()).toHaveLength(3);
  });

  it.each([
    ["HTML", () => new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "Content-Type": "text/html" } })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["invalid JSON", () => new Response("{nope", { status: 200 })],
    ["JSON without an identity", () => reply(200, { csrfToken: "x" })],
    ["an empty identity", () => reply(200, { identity: "" })],
    ["a non-string identity", () => reply(200, { identity: 5 })],
    ["JSON null", () => reply(200, null)],
    ["an array", () => reply(200, [{ identity: "a" }])],
  ])("shows nothing when the probe answers 200 with %s", async (_name, answer) => {
    const { calls } = await start(route(answer), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(probes(calls)).toHaveLength(1);
    expect(banner()).toBeUndefined();
    expect(slotButtons()).toHaveLength(3);
  });

  it("shows nothing when the probe was redirected, even to a 200 page", async () => {
    const redirected = () => Object.defineProperty(reply(200, SIGNED_IN), "redirected", { value: true });
    await start(route(redirected), `/e/${SLUG}`, withSettings({ privacyContact: null }));
    expect(banner()).toBeUndefined();
  });

  it("makes no probe and shows no notice when the settings are unavailable", async () => {
    const unavailable = { clubName: null, website: null, privacyContact: null, logo: null, loaded: false };
    const { calls } = await start(route(() => reply(200, SIGNED_IN)), `/e/${SLUG}`, unavailable);
    expect(probes(calls)).toHaveLength(0);
    expect(banner()).toBeUndefined();
    const { calls: noSettings } = await start(route(() => reply(200, SIGNED_IN)));
    expect(probes(noSettings)).toHaveLength(0);
  });

  it("makes no probe at all when a contact is set", async () => {
    const { calls } = await start(route(() => reply(200, SIGNED_IN)), `/e/${SLUG}`, SETTINGS);
    expect(probes(calls)).toHaveLength(0);
    expect(banner()).toBeUndefined();
  });

  describe("settings that are slow", () => {
    const never = () => new Promise<never>(() => {});
    const startWith = async (settings: Promise<unknown>, wait = 10) => {
      document.body.innerHTML = '<main id="app"></main>';
      const calls: Call[] = [];
      const fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return url === SESSION ? reply(200, SIGNED_IN) : getOk();
      };
      const done = init({
        document, fetch: fetch as unknown as typeof globalThis.fetch, location: { pathname: `/e/${SLUG}` },
        clipboard: undefined, settings: settings as never, settingsTimeoutMs: wait,
      });
      return { calls, done };
    };

    it("renders the form without club details when the settings never arrive, and still finishes", async () => {
      const { calls, done } = await startWith(never());
      await done;
      expect(slotButtons()).toHaveLength(3);
      expect(document.title).toBe("Trial Day");
      expect(document.querySelector(".site-header")).toBeNull();
      expect(document.querySelector(".privacy")).not.toBeNull();
      expect(text()).not.toContain("Questions about your details");
      expect(calls.filter((c) => c.url === SESSION)).toHaveLength(0); // unknown, so no admin probe
      expect(banner()).toBeUndefined();
    });

    it("patches in the header, title and contact when the settings arrive late, keeping what was typed", async () => {
      let arrive!: (s: unknown) => void;
      const late = new Promise((r) => { arrive = r; });
      const { done } = await startWith(late);
      await done;
      expect(document.querySelector(".site-header")).toBeNull();
      slotButton("09:20").click();
      fill("Biscuit", "Ann Lee");
      const dogInput = $("#field-1");

      arrive(SETTINGS);
      await vi.waitFor(() => expect(document.querySelector(".site-header")).not.toBeNull());
      await vi.waitFor(() => expect(document.querySelector(".privacy a")).not.toBeNull());
      expect(document.querySelector(".site-header a")!.textContent).toBe("Barkside Agility");
      expect(document.title).toBe("Trial Day – Barkside Agility");
      expect(document.querySelector(".privacy p:last-child")!.textContent)
        .toBe("Questions about your details, or want them deleted? Contact Ann Lee, ann@barkside.example.");
      expect(document.querySelectorAll(".privacy p:last-child a")).toHaveLength(1);
      // The same form and the same inputs, so nothing typed was lost and the chosen slot is still chosen.
      expect($("#field-1")).toBe(dogInput);
      expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
      expect(($("#field-2") as HTMLInputElement).value).toBe("Ann Lee");
      expect(form().hidden).toBe(false);
      expect(slotButton("09:20").getAttribute("aria-pressed")).toBe("true");
    });

    it("does not wait at all when the settings are quick", async () => {
      const { done } = await startWith(Promise.resolve(SETTINGS), 60_000);
      await done;
      expect(document.title).toBe("Trial Day – Barkside Agility");
      expect(document.querySelector(".privacy a")).not.toBeNull();
    });
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// Lanes and places: three lanes with two places each (the phone design), a single lane with several places, a named lane
// ---------------------------------------------------------------------------------------------------------------------
describe("lanes and places", () => {
  const LANES = [{ id: 11, name: "Ring 1" }, { id: 12, name: "Ring 2" }, { id: 13, name: "A very long lane name for the third ring" }];
  const START = { a: "2026-06-13T08:20:00Z", b: "2026-06-13T08:40:00Z", c: "2026-06-13T09:00:00Z", d: "2026-06-13T09:20:00Z" };
  const end = (iso: string) => new Date(Date.parse(iso) + 15 * 60_000).toISOString().replace(".000Z", "Z");
  const places = (...free: number[]) => LANES.map((l, i) => ({ laneId: l.id, free: free[i] }));
  const view = (start: string, status: "free" | "taken" | "past", ...free: number[]) => ({ start, end: end(start), status, places: places(...free) });
  const LANE_EVENT = { ...EVENT, lanes: LANES, capacity: 2 };
  // 09:20 started; 09:40 all open; 10:00 Ring 2 full, Ring 1 one left; 10:20 nothing free (taken, hidden)
  const LANE_SLOTS = [view(START.a, "past", 1, 1, 1), view(START.b, "free", 2, 2, 2), view(START.c, "free", 1, 0, 2), view(START.d, "taken", 0, 0, 0)];
  const lanesGet = (slots: unknown[] = LANE_SLOTS, ev: unknown = LANE_EVENT) => () => getOk(ev as typeof EVENT, slots);
  // A card is a list item holding a labelled group, so the list's items stay list items.
  const groups = () => [...document.querySelectorAll<HTMLElement>("ul.slot-grid > li.slot-group > div[role=group]")];
  const laneButtons = (time: string) =>
    [...groups().find((g) => g.getAttribute("aria-label") === time)!.querySelectorAll<HTMLButtonElement>("button")];
  const laneButton = (time: string, lane: string) => laneButtons(time).find((b) => b.querySelector(".lane-name")!.textContent === lane)!;
  const bookedIn = (lane = LANES[0]) => reply(201, {
    booking: { slot: { start: START.b, end: end(START.b) }, lane, fields: dogHandler("Biscuit", "Ann Lee") },
    event: LANE_EVENT, icsUrl: ICS_URL,
  });
  const posted = (calls: Call[]) => JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));

  describe("several lanes", () => {
    it("shows one group per time that has a free place, with the time as its name, and counts places", async () => {
      await start(routes(() => bookedIn(), lanesGet()));
      expect(groups().map((g) => g.getAttribute("aria-label"))).toEqual(["09:20", "09:40", "10:00"]);
      expect(groups()).toHaveLength(document.querySelectorAll("ul.slot-grid > li").length);
      for (const li of document.querySelectorAll("ul.slot-grid > li")) expect(li.hasAttribute("role")).toBe(false);
      for (const g of groups()) expect(g.getAttribute("role")).toBe("group");
      expect(groups()[1].querySelector("h3")!.textContent).toBe("09:40");
      expect(text()).toContain("9 places left"); // 09:40 has 6 and 10:00 has 3; the started 09:20 and the taken 10:20 are not counted
    });

    it("lists a button per lane with the name and what is left, and disables a full lane", async () => {
      await start(routes(() => bookedIn(), lanesGet()));
      expect(laneButtons("09:40").map((b) => b.textContent)).toEqual(["Ring 12 left", "Ring 22 left", `${LANES[2].name}2 left`]);
      expect(laneButton("10:00", "Ring 1").textContent).toBe("Ring 11 left");
      const full = laneButton("10:00", "Ring 2");
      expect(full.disabled).toBe(true);
      expect(full.querySelector(".slot-note")!.textContent).toBe("Full");
      expect(full.getAttribute("aria-label")).toBe("10:00, Ring 2, full");
      expect(laneButton("09:40", "Ring 1").getAttribute("aria-label")).toBe("Book 09:40, Ring 1, 2 places left");
      expect(laneButton("10:00", "Ring 1").getAttribute("aria-label")).toBe("Book 10:00, Ring 1, 1 place left");
      full.click();
      expect(form().hidden).toBe(true);
    });

    it("shows a started time as one disabled card", async () => {
      await start(routes(() => bookedIn(), lanesGet()));
      const started = laneButtons("09:20");
      expect(started).toHaveLength(1);
      expect(started[0].disabled).toBe(true);
      expect(started[0].querySelector(".slot-note")!.textContent).toBe("Started");
      expect(started[0].getAttribute("aria-label")).toBe("09:20 slot, started");
    });

    it("uses real buttons, so the keyboard works, and nothing but the lane buttons selects", async () => {
      await start(routes(() => bookedIn(), lanesGet()));
      for (const b of document.querySelectorAll(".slot-group button")) expect(b.tagName).toBe("BUTTON");
      for (const b of document.querySelectorAll(".slot-group button")) expect((b as HTMLButtonElement).type).toBe("button");
      groups()[1].click();
      expect(form().hidden).toBe(true);
    });

    it("selects one lane of one time: aria-pressed only there, heading and submit name time and lane", async () => {
      await start(routes(() => bookedIn(), lanesGet()));
      laneButton("09:40", "Ring 2").click();
      const pressed = [...document.querySelectorAll(".slot-group button[aria-pressed='true']")];
      expect(pressed).toEqual([laneButton("09:40", "Ring 2")]);
      expect(laneButton("09:40", "Ring 1").getAttribute("aria-pressed")).toBe("false");
      expect(laneButton("10:00", "Ring 2").getAttribute("aria-pressed")).toBe("false"); // same lane, other time
      expect(form().hidden).toBe(false);
      expect($("#booking-form h2").textContent).toBe("Booking 09:40 · Ring 2");
      expect($("#booking-form button[type=submit]").textContent).toBe("Confirm booking for 09:40, Ring 2");
      laneButton("10:00", "Ring 1").click();
      expect([...document.querySelectorAll(".slot-group button[aria-pressed='true']")]).toEqual([laneButton("10:00", "Ring 1")]);
      expect($("#booking-form h2").textContent).toBe("Booking 10:00 · Ring 1");
    });

    it("posts the chosen lane with the booking and shows a Lane row, and the copy text has the lane", async () => {
      const { calls, clipboard } = await start(routes(() => bookedIn(LANES[1]), lanesGet()));
      laneButton("09:40", "Ring 2").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(posted(calls)).toMatchObject({ slot: START.b, laneId: 12, field1: "Biscuit", field2: "Ann Lee" });
      const terms = [...document.querySelectorAll("dt")].map((d) => d.textContent);
      expect(terms).toEqual(["When", "Dog", "Handler", "Lane", "Venue", "Cost"]);
      expect(document.querySelectorAll("dd")[3].textContent).toBe("Ring 2");
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy booking")!.click();
      await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
      expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("\nDog: Biscuit\nHandler: Ann Lee\nLane: Ring 2\nVenue: "));
    });

    it("on slot_taken shows the live places from the answer, drops the selection and keeps focus on the notice", async () => {
      const live = [
        { start: START.b, end: end(START.b), places: places(2, 0, 2) },
        { start: START.c, end: end(START.c), places: places(1, 0, 2) },
      ];
      let gets = 0;
      const { calls } = await start(routes(
        () => reply(409, { error: { code: "slot_taken", message: "That slot's just gone." }, freeSlots: live }),
        () => (gets++ === 0 ? getOk(LANE_EVENT, LANE_SLOTS) : new Response("down", { status: 500 })),
      ));
      laneButton("09:40", "Ring 2").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("#notice").textContent).toBe("That slot's just gone."));
      await vi.waitFor(() => expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2));
      expect(groups().map((g) => g.getAttribute("aria-label"))).toEqual(["09:40", "10:00"]); // from the payload when the refetch fails
      expect(laneButton("09:40", "Ring 2").disabled).toBe(true);
      expect(laneButton("09:40", "Ring 2").textContent).toBe("Ring 2Full");
      expect(text()).toContain("7 places left"); // 4 at 09:40, 3 at 10:00
      expect(document.querySelectorAll(".slot-group button[aria-pressed='true']")).toHaveLength(0);
      expect(form().hidden).toBe(true);
      expect(document.activeElement).toBe($("#notice"));
      expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
    });

    it("replaces the list with the refetched one after slot_taken, started times included", async () => {
      let gets = 0;
      await start(routes(
        () => reply(409, { error: { code: "slot_taken", message: "x" }, freeSlots: [] }),
        () => (gets++ === 0 ? getOk(LANE_EVENT, LANE_SLOTS) : getOk(LANE_EVENT, [LANE_SLOTS[0], view(START.c, "free", 1, 0, 0)])),
      ));
      laneButton("09:40", "Ring 1").click();
      fill();
      submit();
      await vi.waitFor(() => expect(groups().map((g) => g.getAttribute("aria-label"))).toEqual(["09:20", "10:00"]));
      expect(text()).toContain("1 place left");
      expect(laneButtons("09:20")[0].disabled).toBe(true);
    });

    const CHANGED = "The event was just changed. The times below are up to date; choose again.";
    const CHOOSE = () => reply(400, { error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { laneId: "Choose a lane." } });

    it("treats fields.laneId (the chosen lane was removed) as a changed event: deselects, says so, shows the fresh lanes and focuses the notice", async () => {
      let gets = 0;
      const { calls } = await start(routes(CHOOSE, () => (gets++ === 0 ? getOk(LANE_EVENT, LANE_SLOTS)
        : getOk({ ...LANE_EVENT, lanes: LANES.slice(0, 2) } as typeof EVENT, [view(START.b, "free", 2, 2, 0)]))));
      laneButton("09:40", "Ring 1").click();
      fill();
      submit();
      await vi.waitFor(() => expect(laneButtons("09:40")).toHaveLength(2));
      expect($("#notice").textContent).toBe(CHANGED);
      expect($(".form-error").textContent).toBe("");
      expect(form().hidden).toBe(true);
      expect(document.querySelectorAll(".slot-group button[aria-pressed='true']")).toHaveLength(0);
      expect(document.activeElement).toBe($("#notice"));
      expect(calls.filter((c) => c.init?.method !== "POST")).toHaveLength(2);
      expect(($("#field-1") as HTMLInputElement).value).toBe("Biscuit");
      // and the booker can go on: choosing a lane of the fresh list posts it
      laneButton("09:40", "Ring 2").click();
      expect(form().hidden).toBe(false);
    });

    it("treats fields.laneId on a page built for one lane (a lane was added meanwhile) the same way, and the page then asks for a lane", async () => {
      let gets = 0;
      await start(routes(CHOOSE, () => (gets++ === 0 ? getOk(EVENT, SLOTS) : getOk(LANE_EVENT, LANE_SLOTS))));
      slotButton("09:20").click();
      fill();
      submit();
      await vi.waitFor(() => expect(groups()).toHaveLength(3));
      expect($("#notice").textContent).toBe(CHANGED);
      expect(form().hidden).toBe(true);
      expect(slotButtons().filter((b) => !b.classList.contains("lane") && !b.classList.contains("past"))).toHaveLength(0);
      expect(document.activeElement).toBe($("#notice"));
    });

    it("refetches on event_changed and shows the new lanes", async () => {
      let gets = 0;
      await start(routes(
        () => reply(409, { error: { code: "event_changed", message: "x" } }),
        () => (gets++ === 0 ? getOk(LANE_EVENT, LANE_SLOTS) : getOk({ ...LANE_EVENT, lanes: LANES.slice(0, 2) } as typeof EVENT, [view(START.b, "free", 2, 2, 0)])),
      ));
      laneButton("09:40", "Ring 1").click();
      fill();
      submit();
      await vi.waitFor(() => expect(laneButtons("09:40")).toHaveLength(2));
      expect($("#notice").textContent).toContain("The event was just changed");
      expect(document.activeElement).toBe($("#notice"));
    });

    it("shows the booking and the Lane row when the key was reused and the server answers with the saved booking", async () => {
      await start(routes(() => reply(422, {
        error: { code: "idempotency_key_reuse", message: "x" },
        booking: { slot: { start: START.b, end: end(START.b) }, lane: LANES[0], fields: dogHandler("Biscuit", "Ann Lee") },
        event: LANE_EVENT, icsUrl: ICS_URL,
      }), lanesGet()));
      laneButton("09:40", "Ring 2").click();
      fill("Other", "Person");
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect([...document.querySelectorAll("dd")].map((d) => d.textContent)).toContain("Ring 1");
    });

    it("closes on 410", async () => {
      await start(routes(() => reply(410, { error: { code: "bookings_closed", message: "closed" } }), lanesGet()));
      laneButton("09:40", "Ring 1").click();
      fill();
      submit();
      await vi.waitFor(() => expect(text()).toContain("Bookings for this event are closed."));
    });

    it("says fully booked when no time has a free place", async () => {
      await start(routes(() => bookedIn(), lanesGet([LANE_SLOTS[3]])));
      expect(groups()).toHaveLength(0);
      expect(text()).toContain("Fully booked");
    });

    it("renders lane names as text", async () => {
      const lanes = [{ id: 1, name: "<b>One</b>" }, { id: 2, name: "Two" }];
      await start(routes(() => bookedIn(), lanesGet(
        [{ start: START.b, end: end(START.b), status: "free", places: [{ laneId: 1, free: 1 }, { laneId: 2, free: 1 }] }],
        { ...EVENT, lanes, capacity: 1 },
      )));
      expect(document.querySelector(".lane-name b")).toBeNull();
      expect(document.querySelector(".lane-name")!.textContent).toBe("<b>One</b>");
    });
  });

  describe("one lane", () => {
    const one = (name: string, capacity: number) => ({ ...EVENT, lanes: [{ id: 5, name }], capacity });
    const oneSlots = [
      { start: START.a, end: end(START.a), status: "taken", places: [{ laneId: 5, free: 0 }] },
      { start: START.b, end: end(START.b), status: "free", places: [{ laneId: 5, free: 2 }] },
      { start: START.c, end: end(START.c), status: "free", places: [{ laneId: 5, free: 1 }] },
    ];

    it("keeps the v1.0 page, and a v1.0 request, for one unnamed lane with one place", async () => {
      const { calls } = await start(routes(() => created(), () => getOk(one("", 1) as typeof EVENT, [
        { ...oneSlots[1], places: [{ laneId: 5, free: 1 }] }, oneSlots[2],
      ])));
      expect(slotButtons().map((b) => b.textContent)).toEqual(["09:40", "10:00"]);
      expect(slotButton("09:40").getAttribute("aria-label")).toBe("Book 09:40 slot");
      expect(text()).toContain("2 slots left");
      slotButton("09:40").click();
      expect($("#booking-form h2").textContent).toBe("Booking 09:40");
      expect($("#booking-form button[type=submit]").textContent).toBe("Confirm booking for 09:40");
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(posted(calls)).not.toHaveProperty("laneId");
      expect([...document.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["When", "Dog", "Handler", "Venue", "Cost"]);
    });

    it("keeps the time grid and adds 'N left' to each time when there are several places", async () => {
      const { calls } = await start(routes(() => created(), () => getOk(one("", 2) as typeof EVENT, oneSlots)));
      expect(document.querySelectorAll("li.slot-group")).toHaveLength(0);
      expect(slotButtons().map((b) => b.textContent)).toEqual(["09:402 left", "10:001 left"]);
      expect(slotButton("09:40").querySelector(".slot-note")!.textContent).toBe("2 left");
      expect(slotButton("09:40").getAttribute("aria-label")).toBe("Book 09:40 slot, 2 places left");
      expect(slotButton("10:00").getAttribute("aria-label")).toBe("Book 10:00 slot, 1 place left");
      expect(text()).toContain("3 places left");
      slotButton("09:40").click();
      expect(slotButton("09:40").getAttribute("aria-pressed")).toBe("true");
      expect($("#booking-form h2").textContent).toBe("Booking 09:40");
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(posted(calls)).toMatchObject({ slot: START.b, laneId: 5 });
      expect([...document.querySelectorAll("dt")].map((d) => d.textContent)).not.toContain("Lane");
    });

    it("says '1 place left' for the last place, and the started slot still reads Started", async () => {
      await start(routes(() => created(), () => getOk(one("", 2) as typeof EVENT, [
        { ...oneSlots[0], status: "past", places: [{ laneId: 5, free: 1 }] }, oneSlots[2],
      ])));
      expect(text()).toContain("1 place left");
      expect(slotButton("09:20").disabled).toBe(true);
    });

    it("names a single named lane in the form and the confirmation, without extra buttons", async () => {
      const { calls } = await start(routes(() => bookedIn({ id: 5, name: "Main ring" }), () => getOk(one("Main ring", 1) as typeof EVENT, [
        { ...oneSlots[1], places: [{ laneId: 5, free: 1 }] },
      ])));
      expect(slotButtons().map((b) => b.textContent)).toEqual(["09:40"]);
      expect(text()).toContain("1 place left");
      slotButton("09:40").click();
      expect($("#booking-form h2").textContent).toBe("Booking 09:40 · Main ring");
      expect($("#booking-form button[type=submit]").textContent).toBe("Confirm booking for 09:40, Main ring");
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect(posted(calls).laneId).toBe(5);
      expect([...document.querySelectorAll("dt")].map((d) => d.textContent)).toContain("Lane");
    });

    it("leaves the Lane row out when the booking's lane has no name", async () => {
      await start(routes(() => bookedIn({ id: 5, name: "" } as never), () => getOk(one("", 2) as typeof EVENT, oneSlots)));
      slotButton("09:40").click();
      fill();
      submit();
      await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
      expect([...document.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["When", "Dog", "Handler", "Venue", "Cost"]);
    });
  });
});

describe("the form of an event's own fields", () => {
  const field = (position: number, label: string, o: { required?: boolean; maxLength?: number } = {}) => ({ position, label, required: o.required ?? true, maxLength: o.maxLength ?? 80 });
  const FOUR = [field(1, "Rider"), field(2, "Pony"), field(3, "Phone", { required: false, maxLength: 12 }), field(4, "Notes", { required: false, maxLength: 40 })];
  const withFields = (fields: ReturnType<typeof field>[]) => ({ ...EVENT, fields });
  const open = async (fields: ReturnType<typeof field>[], post: Handler = () => created()) => {
    const r = await start(routes(post, () => getOk(withFields(fields) as typeof EVENT, SLOTS, { privacyNotice: defaultPrivacyNotice(fields.map((f) => f.label)) })));
    slotButton("09:20").click();
    return r;
  };
  const inputs = () => [...form().querySelectorAll<HTMLInputElement>("input")];
  const labels = () => [...form().querySelectorAll("label")].map((l) => l.textContent);
  const posted = (calls: Call[]) => JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));

  it("renders Dog and Handler as v1.0 did, by their bare labels: ids, names, limits and keyboard hints included", async () => {
    await open(DOG_HANDLER);
    expect(labels()).toEqual(["Dog", "Handler"]);
    expect(inputs().map((i) => [i.id, i.name, i.type, i.required, i.getAttribute("maxlength"), i.getAttribute("autocapitalize"), i.getAttribute("autocomplete"), i.getAttribute("enterkeyhint"), i.getAttribute("aria-describedby")])).toEqual([
      ["field-1", "field1", "text", true, "80", "words", "off", "next", "field-1-error"],
      ["field-2", "field2", "text", true, "80", "words", "off", "done", "field-2-error"],
    ]);
    expect([...form().querySelectorAll("label")].map((l) => l.getAttribute("for"))).toEqual(["field-1", "field-2"]);
    expect([...form().querySelectorAll(".field-error")].map((e) => [e.id, e.getAttribute("role"), e.textContent])).toEqual([["field-1-error", "alert", ""], ["field-2-error", "alert", ""]]);
  });

  it("renders one input for a form of one field, with the enter key saying done", async () => {
    await open([field(1, "Car reg", { maxLength: 10 })]);
    expect(labels()).toEqual(["Car reg"]);
    expect(inputs().map((i) => [i.id, i.getAttribute("maxlength"), i.getAttribute("autocomplete"), i.getAttribute("enterkeyhint"), i.required])).toEqual([["field-1", "10", "off", "done", true]]);
  });

  it("renders four fields in position order: optional ones say so, are not required, and have their own longest value", async () => {
    await open(FOUR);
    expect(labels()).toEqual(["Rider", "Pony", "Phone (optional)", "Notes (optional)"]);
    expect(inputs().map((i) => [i.id, i.required, i.getAttribute("maxlength"), i.getAttribute("autocapitalize"), i.getAttribute("autocomplete"), i.getAttribute("enterkeyhint")])).toEqual([
      ["field-1", true, "80", "words", "off", "next"], ["field-2", true, "80", "words", "off", "next"],
      ["field-3", false, "12", "words", "off", "next"], ["field-4", false, "40", "words", "off", "done"],
    ]);
  });

  it("puts the privacy notice after the last field, naming the labels", async () => {
    await open(FOUR);
    expect(form().querySelector(".privacy")!.textContent).toContain("(Rider, Pony, Phone, Notes)");
    expect(inputs().at(-1)!.compareDocumentPosition(form().querySelector(".privacy")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("sends field1 to fieldN as typed (an optional one left blank as an empty string) and no other names", async () => {
    const { calls } = await open(FOUR);
    type("#field-1", " Ann Lee ");
    type("#field-2", "Biscuit");
    type("#field-4", "Nervous");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(posted(calls)).toEqual({ slot: SLOTS[1].start, field1: " Ann Lee ", field2: "Biscuit", field3: "", field4: "Nervous", idempotencyKey: expect.any(String) });
  });

  it("sends only field1 for a form of one field", async () => {
    const { calls } = await open([field(1, "Car reg")]);
    type("#field-1", "AB12 CDE");
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(Object.keys(posted(calls)).sort()).toEqual(["field1", "idempotencyKey", "slot"]);
  });

  it("shows each error under its own input, from fields.fieldN, with aria-invalid and the bare-label wording the server gives", async () => {
    await open(FOUR, () => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." },
      fields: { field1: "Rider is required.", field3: "Phone must be at most 12 characters." },
    }));
    submit();
    await vi.waitFor(() => expect(form().textContent).toContain("Rider is required."));
    const state = () => [1, 2, 3, 4].map((n) => [$(`#field-${n}`).getAttribute("aria-invalid"), $(`#field-${n}-error`).textContent]);
    expect(state()).toEqual([["true", "Rider is required."], [null, ""], ["true", "Phone must be at most 12 characters."], [null, ""]]);
    expect($(".form-error").textContent).toBe("");
    expect($("#field-1").getAttribute("aria-describedby")).toBe("field-1-error");
  });

  it("clears the errors when another slot is chosen, and maps no error to a field the event doesn't have", async () => {
    await open([field(1, "Car reg")], () => reply(400, {
      error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: { field1: "Car reg is required.", field2: "ignored" },
    }));
    submit();
    await vi.waitFor(() => expect($("#field-1-error").textContent).toBe("Car reg is required."));
    expect(document.getElementById("field-2-error")).toBeNull();
    expect($(".form-error").textContent).toBe("");
    slotButton("09:40").click();
    expect($("#field-1-error").textContent).toBe("");
    expect($("#field-1").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows the form error when the answer has no field error of ours at all", async () => {
    await open([field(1, "Car reg")], () => reply(400, { error: { code: "invalid_input", message: "Check the highlighted fields." }, fields: {} }));
    submit();
    await vi.waitFor(() => expect($(".form-error").textContent).toBe("Check the highlighted fields."));
  });

  it("shows the confirmation with a row for each value the booking has, labelled, in order; an optional blank is not shown", async () => {
    await open(FOUR, () => reply(201, {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: [{ label: "Rider", value: "Ann Lee" }, { label: "Pony", value: "Biscuit" }, { label: "Notes", value: "Nervous" }] },
      event: withFields(FOUR), icsUrl: ICS_URL,
    }));
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    const rows = [...document.querySelectorAll("dl.facts dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(rows).toEqual([["When", "Saturday 13 June 2026, 09:20–09:35"], ["Rider", "Ann Lee"], ["Pony", "Biscuit"], ["Notes", "Nervous"], ["Venue", "SW1A 1AA"], ["Cost", "£15.00"]]);
  });

  it("copies the labelled values", async () => {
    const { clipboard } = await open([field(1, "Car reg")], () => reply(201, {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: [{ label: "Car reg", value: "AB12 CDE" }] },
      event: withFields([field(1, "Car reg")]), icsUrl: ICS_URL,
    }));
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy booking")!.click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("Trial Day\nSaturday 13 June 2026, 09:20–09:35\nCar reg: AB12 CDE\nVenue: SW1A 1AA\nCost: £15.00\nBring water.\nBe kind."));
  });

  it("renders labels and values as text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    await open([field(1, evil)], () => reply(201, {
      booking: { slot: { start: SLOTS[1].start, end: SLOTS[1].end }, fields: [{ label: evil, value: "<u>x</u>" }] }, event: withFields([field(1, evil)]), icsUrl: ICS_URL,
    }));
    expect(document.querySelector("img")).toBeNull();
    expect(labels()).toEqual([evil]);
    submit();
    await vi.waitFor(() => expect($("h1").textContent).toBe("You're booked in"));
    expect(document.querySelector("img, u")).toBeNull();
    expect(text()).toContain(evil);
  });

  it("keeps what was typed in every field after a refetch (slot_taken)", async () => {
    await open(FOUR, () => reply(409, { error: { code: "slot_taken", message: "gone" }, freeSlots: [{ start: SLOTS[2].start, end: SLOTS[2].end }] }));
    type("#field-1", "Ann");
    type("#field-3", "0770");
    submit();
    await vi.waitFor(() => expect(text()).toContain("That slot's just gone."));
    slotButton("09:40").click();
    expect(($("#field-1") as HTMLInputElement).value).toBe("Ann");
    expect(($("#field-3") as HTMLInputElement).value).toBe("0770");
  });
});
