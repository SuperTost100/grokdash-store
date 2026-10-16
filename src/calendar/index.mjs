// Calendar: your calendars on the agenda, read from their secret iCal addresses (Google Calendar has one per calendar).
// Read-only. Recurring events, moved occurrences and cancelled ones are handled.

import ICAL from "ical.js";
import { settings, agenda, status, every, tz as dashboardTz, addDays } from "../../sdk/dashboard.mjs";

const pad = (n) => String(n).padStart(2, "0");

/** A moment as the dashboard's wall-clock string ("YYYY-MM-DDTHH:MM:SS") in `tz`. */
export function localStamp(d, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** The instant a wall-clock time in `tz` happens, in Unix ms. */
function zonedToEpoch(stamp, tz) {
  const guess = Date.parse(stamp + "Z");
  let t = guess;
  // Two passes settle it across a daylight-saving change.
  for (let i = 0; i < 2; i++) t += guess - Date.parse(localStamp(new Date(t), tz) + "Z");
  return t;
}

/**
 * Whether an event touches the days [from, to). A datetime end is exclusive (ending at 00:00 doesn't
 * touch that day); a date-only end includes that day. The dashboard checks the same rule and rejects the call otherwise.
 */
export function overlaps(start, end, from, to) {
  if (!(start < to)) return false;
  if (!end) return start >= from;
  return end.length === 10 ? end >= from : end > `${from}T00:00:00`;
}

/** The http(s) addresses in the setting. webcal:// is what calendar apps hand out; it means https. */
export function calendarUrls(raw) {
  return String(raw ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((u) => u.replace(/^webcal:\/\//i, "https://"))
    .filter((u) => {
      try {
        return /^https?:$/.test(new URL(u).protocol);
      } catch {
        return false;
      }
    });
}

/** An iCal time as the dashboard's wall-clock string: a date for all-day, a datetime in `tz` otherwise. */
function stamp(t, tz) {
  if (t.isDate) return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
  // A floating time (no zone) means the same clock time wherever you are.
  if (t.zone === ICAL.Timezone.localTimezone) return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
  return localStamp(t.toJSDate(), tz);
}

function occurrence(start, end, item, tz, app) {
  const s = stamp(start, tz);
  let e = end ? stamp(end, tz) : "";
  // iCal all-day ends are exclusive (a one-day event ends the next day); the dashboard's are inclusive.
  if (start.isDate && e) e = addDays(e, -1) > s ? addDays(e, -1) : "";
  if (e === s) e = "";
  return {
    title: (item.summary || "Busy").slice(0, 200),
    start: s,
    end: e,
    location: (item.location || "").slice(0, 200),
    allDay: start.isDate,
    app,
  };
}

const cancelled = (c) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
const byStart = (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

/** Repeats expanded per event, about 0.6 s of work. An hourly event from years ago can need more. */
const MAX_REPEATS = 100_000;

/**
 * The events of one iCal file that touch the days [from, to), in `tz`.
 * `skipped` counts repeating events too long to expand, so the status can say the agenda may be missing one.
 */
export function eventsFromIcs(ics, from, to, tz, app = "") {
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const vtz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(vtz);
  const masters = new Map();
  const exceptions = [];
  for (const ve of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }

  const windowEnd = zonedToEpoch(`${to}T00:00:00`, tz);
  const out = [];
  const add = (start, end, item) => {
    const o = occurrence(start, end, item, tz, app);
    if (overlaps(o.start, o.end, from, to)) out.push(o);
  };
  // A moved occurrence counts on the day it moved to, wherever its original date was.
  // Its original date is left out of the series below.
  const moved = new Map();
  for (const ex of exceptions) {
    if (!masters.has(ex.uid)) continue;
    let set = moved.get(ex.uid);
    if (!set) moved.set(ex.uid, (set = new Set()));
    set.add(ex.recurrenceId.toUnixTime().toString());
    if (!cancelled(ex.component)) add(ex.startDate, ex.endDate, ex);
  }
  let skipped = 0;
  for (const ev of masters.values()) {
    if (cancelled(ev.component)) continue;
    if (!ev.isRecurring()) {
      add(ev.startDate, ev.endDate, ev);
      continue;
    }
    const skip = moved.get(ev.uid);
    const it = ev.iterator();
    let n = 0;
    for (let next = it.next(); next; next = it.next()) {
      if (++n > MAX_REPEATS) {
        skipped++;
        break;
      }
      // Past the window (with a day's margin for time zones), nothing more can match.
      if (next.toJSDate().getTime() >= windowEnd + 86_400_000) break;
      // An occurrence moved on its own was added above, on the day it moved to.
      if (skip?.has(next.toUnixTime().toString())) continue;
      // getOccurrenceDetails applies changes made to "this and all future" occurrences.
      const d = ev.getOccurrenceDetails(next);
      if (d.item !== ev && cancelled(d.item.component)) continue;
      add(d.startDate, d.endDate, d.item);
    }
  }
  return { events: out.sort(byStart), skipped };
}

/**
 * Fetch every calendar and return the events of the days [from, to). Fails if any calendar fails,
 * so the agenda never shows half a day.
 */
export async function readCalendars(urls, from, to, tz, fetchImpl = fetch) {
  const events = [];
  let skipped = 0;
  for (const [i, url] of urls.entries()) {
    // The address holds a private token, and fetch errors quote it. So errors name the calendar by its
    // position and give only a short reason, never the message of the error underneath.
    const name = `Calendar ${i + 1}`;
    let res;
    let text;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
      text = await res.text();
    } catch (err) {
      const why = err.name === "TimeoutError" ? "didn't answer in time" : err.cause?.code === "ENOTFOUND" ? "has a server name that doesn't exist" : "couldn't be reached";
      throw new Error(`${name} ${why}. Check its address.`);
    }
    if (!res.ok) throw new Error(`${name} answered ${res.status}${res.status === 404 ? ". Its secret address may have been reset" : ""}.`);
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error(`${name} isn't an iCal file. Use the secret address in iCal format.`);
    const host = new URL(url).hostname;
    let parsed;
    try {
      parsed = eventsFromIcs(text, from, to, tz, /(^|\.)google\.com$/i.test(host) ? "googlecalendar" : "");
    } catch {
      throw new Error(`${name} couldn't be read: the iCal file is broken.`);
    }
    events.push(...parsed.events);
    skipped += parsed.skipped;
  }
  return { events: events.sort(byStart), skipped };
}

/** The dashboard takes up to 200 events per call. */
const MAX_EVENTS = 200;

async function sync() {
  const urls = calendarUrls(settings.urls);
  if (!urls.length) throw new Error("No usable iCal address. Use the secret address in iCal format (http or https).");
  const days = Math.min(31, Math.max(1, Math.round(Number(settings.days)) || 3));
  const from = localStamp(new Date(), dashboardTz).slice(0, 10);
  const to = addDays(from, days);
  const { events, skipped } = await readCalendars(urls, from, to, dashboardTz);
  // The earliest events matter most, and sorting already put them first.
  await agenda(events.slice(0, MAX_EVENTS), from, to);
  const when = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: dashboardTz });
  const extra = [
    events.length > MAX_EVENTS ? `showing the first ${MAX_EVENTS}` : "",
    skipped ? `${skipped} repeating event${skipped === 1 ? "" : "s"} too long to expand` : "",
  ].filter(Boolean);
  await status(`${events.length} event${events.length === 1 ? "" : "s"} from ${urls.length} calendar${urls.length === 1 ? "" : "s"}, read ${when}${extra.length ? ` (${extra.join(", ")})` : ""}`);
}

if (process.env.DASH_URL) every(Math.max(1, Number(settings.every) || 10) * 60_000, sync);
