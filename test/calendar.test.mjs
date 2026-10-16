import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { eventsFromIcs, readCalendars, calendarUrls, overlaps } from "../src/calendar/index.mjs";

const ICS = fs.readFileSync(new URL("./fixtures/calendar.ics", import.meta.url), "utf8");
const VCAL = (body) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...body.trim().split("\n").map((l) => l.trim()), "END:VCALENDAR"].join("\r\n");

test("recurring events, exceptions, all-day and cancelled events land on the right days", () => {
  const { events } = eventsFromIcs(ICS, "2026-10-12", "2026-10-14", "Europe/Rome", "googlecalendar");
  assert.deepEqual(events.map((e) => [e.title, e.start, e.end, e.allDay]), [
    ["Trip to Biella", "2026-10-11", "2026-10-13", true],
    ["Analisi II (moved)", "2026-10-12T14:00:00", "2026-10-12T15:30:00", false],
    ["Dentist", "2026-10-12T17:15:00", "2026-10-12T18:00:00", false],
    ["Day off", "2026-10-13", "", true],
  ]);
  assert.ok(events.every((e) => e.app === "googlecalendar"));
  const later = eventsFromIcs(ICS, "2026-10-14", "2026-10-16", "Europe/Rome", "").events;
  assert.deepEqual(later.map((e) => [e.title, e.start, e.location]), [["Analisi II", "2026-10-14T08:30:00", "Aula 7"]]);
});

test("every event overlaps the window, which the dashboard checks", () => {
  const { events } = eventsFromIcs(ICS, "2026-10-12", "2026-10-14", "Europe/Rome");
  assert.ok(events.every((e) => overlaps(e.start, e.end, "2026-10-12", "2026-10-14")));
  // A datetime end at midnight doesn't touch the next day; a date-only end does.
  assert.equal(overlaps("2026-10-11T22:00:00", "2026-10-12T00:00:00", "2026-10-12", "2026-10-14"), false);
  assert.equal(overlaps("2026-10-11", "2026-10-12", "2026-10-12", "2026-10-14"), true);
});

test("an occurrence moved into today from a later week shows today, once", () => {
  const ics = VCAL(`
    BEGIN:VEVENT
    UID:w@x
    SUMMARY:Weekly
    DTSTART:20261007T080000Z
    DTEND:20261007T090000Z
    RRULE:FREQ=WEEKLY
    END:VEVENT
    BEGIN:VEVENT
    UID:w@x
    RECURRENCE-ID:20261021T080000Z
    SUMMARY:Weekly (moved up)
    DTSTART:20261014T150000Z
    DTEND:20261014T160000Z
    END:VEVENT`);
  const { events } = eventsFromIcs(ics, "2026-10-14", "2026-10-16", "Europe/Rome", "");
  assert.deepEqual(events.map((e) => [e.title, e.start]), [["Weekly", "2026-10-14T10:00:00"], ["Weekly (moved up)", "2026-10-14T17:00:00"]]);
  const week = eventsFromIcs(ics, "2026-10-21", "2026-10-23", "Europe/Rome", "").events;
  assert.deepEqual(week, [], "its original date is empty");
});

test("a daily series that began years ago still shows, and one too long to expand is counted", () => {
  const old = VCAL(`
    BEGIN:VEVENT
    UID:d@x
    SUMMARY:Since 2010
    DTSTART:20100101T080000Z
    DTEND:20100101T083000Z
    RRULE:FREQ=DAILY
    END:VEVENT`);
  assert.deepEqual(eventsFromIcs(old, "2026-10-14", "2026-10-15", "Europe/Rome", "").events.map((e) => e.start), ["2026-10-14T10:00:00"]);
  const minutely = VCAL(`
    BEGIN:VEVENT
    UID:m@x
    SUMMARY:Every minute
    DTSTART:20200101T000000Z
    DTEND:20200101T000100Z
    RRULE:FREQ=MINUTELY
    END:VEVENT`);
  assert.equal(eventsFromIcs(minutely, "2026-10-14", "2026-10-15", "Europe/Rome", "").skipped, 1);
});

test("a change to this and all future occurrences applies", () => {
  const ics = VCAL(`
    BEGIN:VEVENT
    UID:f@x
    SUMMARY:Seminar
    DTSTART:20261007T080000Z
    DTEND:20261007T090000Z
    RRULE:FREQ=WEEKLY
    END:VEVENT
    BEGIN:VEVENT
    UID:f@x
    RECURRENCE-ID;RANGE=THISANDFUTURE:20261014T080000Z
    SUMMARY:Seminar (new time)
    DTSTART:20261014T100000Z
    DTEND:20261014T110000Z
    END:VEVENT`);
  const later = eventsFromIcs(ics, "2026-10-21", "2026-10-22", "Europe/Rome", "").events;
  assert.deepEqual(later.map((e) => [e.title, e.start]), [["Seminar (new time)", "2026-10-21T12:00:00"]]);
});

test("addresses: webcal becomes https, junk is dropped", () => {
  assert.deepEqual(calendarUrls("webcal://calendar.google.com/secret-abc  https://example.com/b.ics\nftp://nope"), [
    "https://calendar.google.com/secret-abc",
    "https://example.com/b.ics",
  ]);
  assert.deepEqual(calendarUrls("https://example.com:99999/x.ics"), [], "an address that doesn't parse is dropped");
  assert.deepEqual(calendarUrls(undefined), []);
});

test("readCalendars merges calendars, sorted, and tags Google ones", async () => {
  const other = VCAL(`
    BEGIN:VEVENT
    UID:o@x
    SUMMARY:Elsewhere
    DTSTART:20261012T060000Z
    DTEND:20261012T070000Z
    END:VEVENT`);
  const fake = async (url) => new Response(String(url).includes("google.com") ? ICS : other, { status: 200 });
  const { events } = await readCalendars(["https://calendar.google.com/a.ics", "https://example.com/b.ics"], "2026-10-12", "2026-10-14", "Europe/Rome", fake);
  assert.deepEqual(events.map((e) => [e.title, e.app]), [
    ["Trip to Biella", "googlecalendar"],
    ["Elsewhere", ""],
    ["Analisi II (moved)", "googlecalendar"],
    ["Dentist", "googlecalendar"],
    ["Day off", "googlecalendar"],
  ]);
});

test("errors never show the secret address", async () => {
  const url = "https://calendar.google.com/private-token/basic.ics";
  const read = (fake) => readCalendars([url], "2026-10-12", "2026-10-14", "Europe/Rome", fake);
  const quiet = (err) => !/private-token/.test(err.message);

  const leaky = async (input) => { throw new TypeError(`fetch failed for ${String(input)}`); };
  await assert.rejects(read(leaky), (err) => err.message === "Calendar 1 couldn't be reached. Check its address." && quiet(err));

  const missing = async () => new Response("nope", { status: 404 });
  await assert.rejects(read(missing), (err) => /Calendar 1 answered 404/.test(err.message) && quiet(err));

  const html = async () => new Response("<html></html>", { status: 200 });
  await assert.rejects(read(html), (err) => /Calendar 1 isn't an iCal file/.test(err.message) && quiet(err));

  const broken = async () => new Response("BEGIN:VCALENDAR\r\nBEGIN:VEVENT private-token\r\n", { status: 200 });
  await assert.rejects(read(broken), (err) => /Calendar 1 couldn't be read/.test(err.message) && quiet(err));
});
