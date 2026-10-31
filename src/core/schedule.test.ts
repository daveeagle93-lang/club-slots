import { describe, expect, it } from "vitest";
import { generateSchedule, type ScheduleInput } from "./schedule";

describe("generateSchedule", () => {
  it("fits back-to-back sessions exactly into the event when there are no breaks", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 0,
      breaks: [],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T10:00:00Z" },
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:00:00Z" },
      { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:30:00Z" },
      { start: "2026-06-06T11:30:00Z", end: "2026-06-06T12:00:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("spaces sessions by session length plus gap", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T11:00:00Z",
      sessionMinutes: 20,
      gapMinutes: 10,
      breaks: [],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:20:00Z" },
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T09:50:00Z" },
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:20:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T10:50:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("drops a session that overruns a break by more than the threshold and resumes at the break end, with no suggestion", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 45,
      gapMinutes: 0,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
    });
    // 09:45-10:30 overruns the 10:00 break start by 30 minutes, so it is not placed.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:45:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:15:00Z" },
      { start: "2026-06-06T11:15:00Z", end: "2026-06-06T12:00:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("suggests moving the break later when a dropped session overruns it by no more than the threshold", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
    });
    // 09:35-10:05 overruns the break start by 5 minutes: not placed, but advised on.
    // Sessions resume at the ORIGINAL break end (10:30), not the suggested one.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:00:00Z" },
      { start: "2026-06-06T11:05:00Z", end: "2026-06-06T11:35:00Z" },
    ]);
    expect(result.suggestions).toEqual([
      {
        droppedSlot: { start: "2026-06-06T09:35:00Z", end: "2026-06-06T10:05:00Z" },
        break: { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        overrunMinutes: 5,
        suggestedBreak: { start: "2026-06-06T10:05:00Z", end: "2026-06-06T10:35:00Z" },
      },
    ]);
  });

  it("skips every break, whatever order they are given in, and resumes after each", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T13:00:00Z",
      sessionMinutes: 25,
      gapMinutes: 5,
      breaks: [
        { start: "2026-06-06T12:00:00Z", end: "2026-06-06T12:20:00Z" },
        { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
      ],
    });
    // The cursor lands exactly on each break start, so it must jump to the break end.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:25:00Z" },
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T09:55:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T10:55:00Z" },
      { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:25:00Z" },
      { start: "2026-06-06T11:30:00Z", end: "2026-06-06T11:55:00Z" },
      { start: "2026-06-06T12:20:00Z", end: "2026-06-06T12:45:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("leaves early-finish time before a break as unused buffer and never moves a break earlier", () => {
    const breaks = [
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
      { start: "2026-06-06T12:40:00Z", end: "2026-06-06T13:10:00Z" },
    ];
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T14:00:00Z",
      sessionMinutes: 45,
      gapMinutes: 0,
      breaks,
    });
    // 09:45-10:00 is left empty: the next 45-minute session would overrun the 10:00 break.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:45:00Z" },
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:15:00Z" },
      { start: "2026-06-06T11:15:00Z", end: "2026-06-06T12:00:00Z" },
      { start: "2026-06-06T13:10:00Z", end: "2026-06-06T13:55:00Z" },
    ]);
    expect(breaks).toEqual([
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
      { start: "2026-06-06T12:40:00Z", end: "2026-06-06T13:10:00Z" },
    ]);
    expect(result.suggestions).toHaveLength(1);
    for (const suggestion of result.suggestions) {
      expect(suggestion.break).toEqual(breaks[1]);
      expect(Date.parse(suggestion.suggestedBreak.start)).toBeGreaterThanOrEqual(
        Date.parse(suggestion.break.start),
      );
    }
  });

  it("drops a final session that would run past the event end, without a suggestion", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T10:45:00Z",
      sessionMinutes: 30,
      gapMinutes: 0,
      breaks: [],
    });
    // 10:30-11:00 would overrun the 10:45 end.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T10:00:00Z" },
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("judges a session against the earliest break it overruns, regardless of input order", () => {
    // 09:50-10:20 overruns both breaks; the earliest start (10:00) gives a 20-minute overrun,
    // beyond the threshold, whereas the later break (10:10) would wrongly give only 10.
    const result = generateSchedule({
      start: "2026-06-06T09:50:00Z",
      end: "2026-06-06T11:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 0,
      breaks: [
        { start: "2026-06-06T10:10:00Z", end: "2026-06-06T10:20:00Z" },
        { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:05:00Z" },
      ],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T10:20:00Z", end: "2026-06-06T10:50:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  // The first session (09:00 onwards) overruns the 10:00-10:30 break start by exactly `overrun` minutes.
  const overrunBy = (overrun: number, nearMissMinutes?: number) =>
    generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 60 + overrun,
      gapMinutes: 0,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
      nearMissMinutes,
    });

  it("suggests a break move when the overrun equals the default threshold of 10 minutes", () => {
    const result = overrunBy(10);
    expect(result.slots).toEqual([
      { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:40:00Z" },
    ]);
    expect(result.suggestions).toEqual([
      {
        droppedSlot: { start: "2026-06-06T09:00:00Z", end: "2026-06-06T10:10:00Z" },
        break: { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        overrunMinutes: 10,
        suggestedBreak: { start: "2026-06-06T10:10:00Z", end: "2026-06-06T10:40:00Z" },
      },
    ]);
  });

  it("makes no suggestion when the overrun is one minute beyond the default threshold", () => {
    expect(overrunBy(11).suggestions).toEqual([]);
  });

  it("honours a custom threshold of 0 by never suggesting", () => {
    expect(overrunBy(1, 0).suggestions).toEqual([]);
  });

  it("honours a custom threshold of 20 by suggesting for a 20-minute overrun", () => {
    const result = overrunBy(20, 20);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.overrunMinutes).toBe(20);
  });

  it("suppresses the suggestion when the moved break would overlap the next break, leaving slots unchanged", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [
        { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        { start: "2026-06-06T10:30:00Z", end: "2026-06-06T11:00:00Z" },
      ],
    });
    // The dropped 09:35-10:05 session would move the first break to 10:05-10:35, into the second.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:30:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("suppresses the suggestion when the moved break would run past the event end, leaving slots unchanged", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T10:30:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
    });
    // The suggested break 10:05-10:35 would end after the 10:30 event end.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("keeps the suggestion when the moved break exactly touches the start of the next break", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [
        { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        { start: "2026-06-06T10:35:00Z", end: "2026-06-06T11:00:00Z" },
      ],
    });
    // The suggested break 10:05-10:35 ends exactly where the second break starts: not an overlap.
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:30:00Z" },
    ]);
    expect(result.suggestions).toEqual([
      {
        droppedSlot: { start: "2026-06-06T09:35:00Z", end: "2026-06-06T10:05:00Z" },
        break: { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        overrunMinutes: 5,
        suggestedBreak: { start: "2026-06-06T10:05:00Z", end: "2026-06-06T10:35:00Z" },
      },
    ]);
  });

  it("keeps the suggestion when the moved break ends exactly at the event end", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T10:35:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
    ]);
    expect(result.suggestions).toEqual([
      {
        droppedSlot: { start: "2026-06-06T09:35:00Z", end: "2026-06-06T10:05:00Z" },
        break: { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
        overrunMinutes: 5,
        suggestedBreak: { start: "2026-06-06T10:05:00Z", end: "2026-06-06T10:35:00Z" },
      },
    ]);
  });

  it("lets a session that ends exactly at a break start fit", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T11:00:00Z",
      sessionMinutes: 60,
      gapMinutes: 0,
      breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" }],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T10:00:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("delays the first slot when a break begins at the very start of the event", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T10:30:00Z",
      sessionMinutes: 30,
      gapMinutes: 0,
      breaks: [{ start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" }],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T10:00:00Z" },
      { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
    ]);
  });

  it("ignores breaks wholly outside the event", () => {
    const result = generateSchedule({
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T10:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 0,
      breaks: [
        { start: "2026-06-06T07:00:00Z", end: "2026-06-06T08:00:00Z" },
        { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:30:00Z" },
      ],
    });
    expect(result.slots).toEqual([
      { start: "2026-06-06T09:00:00Z", end: "2026-06-06T09:30:00Z" },
      { start: "2026-06-06T09:30:00Z", end: "2026-06-06T10:00:00Z" },
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = {
      start: "2026-06-06T09:00:00Z",
      end: "2026-06-06T12:00:00Z",
      sessionMinutes: 30,
      gapMinutes: 5,
      breaks: [
        { start: "2026-06-06T11:00:00Z", end: "2026-06-06T11:15:00Z" },
        { start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:30:00Z" },
      ],
    };
    const before = structuredClone(input);
    generateSchedule(input);
    expect(input).toEqual(before);
  });

  const valid: ScheduleInput = {
    start: "2026-06-06T09:00:00Z",
    end: "2026-06-06T12:00:00Z",
    sessionMinutes: 30,
    gapMinutes: 0,
    breaks: [],
  };

  it.each<[string, Partial<ScheduleInput>]>([
    ["start in the wrong format", { start: "2026-06-06 09:00" }],
    ["start with milliseconds", { start: "2026-06-06T09:00:00.000Z" }],
    ["end that is not a real date", { end: "2026-02-30T12:00:00Z" }],
    ["end equal to start", { end: "2026-06-06T09:00:00Z" }],
    ["end before start", { end: "2026-06-06T08:00:00Z" }],
    ["break with a malformed instant", { breaks: [{ start: "10:00", end: "2026-06-06T10:30:00Z" }] }],
    ["break ending before it starts", { breaks: [{ start: "2026-06-06T10:30:00Z", end: "2026-06-06T10:00:00Z" }] }],
    ["break of zero length", { breaks: [{ start: "2026-06-06T10:00:00Z", end: "2026-06-06T10:00:00Z" }] }],
    ["zero sessionMinutes", { sessionMinutes: 0 }],
    ["fractional sessionMinutes", { sessionMinutes: 7.5 }],
    ["negative gapMinutes", { gapMinutes: -1 }],
    ["fractional gapMinutes", { gapMinutes: 2.5 }],
    ["negative nearMissMinutes", { nearMissMinutes: -1 }],
    ["fractional nearMissMinutes", { nearMissMinutes: 0.5 }],
  ])("throws a RangeError for %s", (_label, overrides) => {
    expect(() => generateSchedule({ ...valid, ...overrides })).toThrow(RangeError);
  });
});
