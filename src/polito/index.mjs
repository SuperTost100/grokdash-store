// PoliTO: course avvisi, school messages and deadlines, read through areadidattica
// (github.com/SuperTost100/areadidattica-cli), a local JSON API over the PoliTO Students app.
// Unread avvisi become cards, deadlines go on the agenda, and closing a card marks the avviso read on PoliTO.

import { settings, post, close, listCards, agenda, panel, status, onAction, every, memory, log, tz } from "../../sdk/dashboard.mjs";

const APP = "polito";
/** A card's body holds up to 2000 characters, which is all the dashboard's API takes. */
const BODY_MAX = 2000;
const AGENDA_DAYS = 30;
/** A deadline this close becomes a card in Needs you, not just a line on the agenda. */
const CARD_DAYS = 3;
const DEADLINE_KEY = "deadline-card:";
const PANEL_DEADLINES = 8;
/** After a failed check, try again sooner than the next scheduled one, but not so soon that a wrong password is retried every minute. */
const RETRY_MS = 10 * 60_000;

export const isDeadlineKey = (key) => String(key ?? "").startsWith(DEADLINE_KEY);
const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const dayIn = (at, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
const isDay = (d) => /^\d{4}-\d{2}-\d{2}/.test(d.date);
const httpLink = (u) => (u && /^https?:\/\//i.test(u) ? u : "");

// ---------- areadidattica ----------

export class Polito {
  constructor(base, token, fetchImpl = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }

  // A cold /items call fetches every course's notices one at a time, so reads get a minute.
  async call(method, path, timeoutMs = 60_000) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.json().then((b) => b.error ?? "", () => "");
      const hint = res.status === 401 ? " Check the token setting." : "";
      throw new Error(`areadidattica answered ${res.status} on ${method} ${path}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return res.json();
  }

  async unread() {
    return (await this.call("GET", "/items?unread=true")).items;
  }

  async deadlines(from, to) {
    return (await this.call("GET", `/deadlines?from=${from}&to=${to}`)).deadlines;
  }

  async markRead(id) {
    await this.call("POST", `/items/${encodeURIComponent(id)}/read`, 15_000);
  }
}

// ---------- cards ----------

const GREETING = /^(buongiorno|buonasera|salve|ciao|gentil[ei]|car[eio]|egregi|dear|hello|hi)\b/i;

/**
 * The first line that says something becomes the card title, so it tells what the avviso is about.
 * The body is what follows that line, or the whole text when the title had to be cut.
 */
export function split(text) {
  // Table rows (tab-separated cells) never make a title.
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.includes("\t") && !(l.length < 40 && GREETING.test(l))) ?? "";
  if (!line) return { title: "", body: text.trim() };
  if (line.length <= 140) return { title: line, body: text.slice(text.indexOf(line) + line.length).trim() };
  const cut = line.slice(0, 140);
  return { title: cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : 139).trimEnd() + "…", body: text.trim() };
}

/** Keep whole lines when a long body has to be cut, so a timetable doesn't end in half a row. */
function fit(body) {
  if (body.length <= BODY_MAX) return body;
  const cut = body.slice(0, BODY_MAX - 1);
  const line = cut.lastIndexOf("\n");
  return (line > BODY_MAX / 2 ? cut.slice(0, line) : cut).trimEnd() + "…";
}

export function politoCard(p, zone) {
  const sent = new Date(p.sentAt);
  const { title, body } = split(p.text);
  return {
    key: p.id,
    section: "needs",
    kind: "reminder",
    title: title || p.title.slice(0, 200),
    body: fit(body),
    // The card's own time is when the dashboard first saw it, so say when PoliTO sent it.
    context: Number.isNaN(sent.getTime())
      ? ""
      : `${p.kind === "avviso" ? "Avviso" : "Messaggio"} del ${sent.toLocaleString("it-IT", { timeZone: zone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`,
    source: `PoliTO · ${p.course ?? (p.kind === "message" ? "Messaggi" : "Avvisi")}`.slice(0, 120),
    app: APP,
    link: httpLink(p.sourceUrl),
    urgent: p.urgent ? "Emergenza" : "",
  };
}

const daysUntil = (day, today) => Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86_400_000);
const weekday = (day) => new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** "Due today", "Due tomorrow" or "Due Friday". */
export function dueLabel(day, today) {
  const days = daysUntil(day, today);
  return days <= 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due ${weekday(day)}`;
}

/** A card for a deadline in the next three days. It leaves on its own once the day is over. */
export function deadlineCard(d, today) {
  const day = d.date.slice(0, 10);
  return {
    key: `${DEADLINE_KEY}${d.id}`,
    section: "needs",
    kind: "reminder",
    title: d.title.slice(0, 200),
    body: [d.course, d.type].filter(Boolean).join(" · "),
    source: `PoliTO · ${d.course ?? "Scadenze"}`.slice(0, 120),
    app: APP,
    link: httpLink(d.url),
    urgent: dueLabel(day, today),
    // A day without a time runs out at the end of that day.
    expires: day,
  };
}

/** Deadlines as all-day agenda events. The window's end day isn't included, so neither are deadlines on it. */
export function agendaEvents(deadlines, from, to) {
  return deadlines
    .filter((d) => isDay(d) && d.date.slice(0, 10) >= from && d.date.slice(0, 10) < to)
    .map((d) => ({ title: d.title.slice(0, 200), start: d.date.slice(0, 10), end: "", location: "", allDay: true, app: APP }));
}

/** The panel: the next deadlines and a button to check now. */
export function panelBlocks(deadlines, today) {
  const next = deadlines.filter((d) => isDay(d) && d.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const items = next.slice(0, PANEL_DEADLINES).map((d) => {
    const day = d.date.slice(0, 10);
    const days = daysUntil(day, today);
    return {
      title: d.title.slice(0, 200),
      sub: [d.course, d.type].filter(Boolean).join(" · ").slice(0, 200),
      badge: days <= 0 ? "Today" : days === 1 ? "Tomorrow" : new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      link: httpLink(d.url),
    };
  });
  return [
    items.length ? { type: "list", items } : { type: "text", text: `No deadlines in the next ${AGENDA_DAYS} days.` },
    { type: "buttons", items: [{ label: "Check now", instruction: "Check PoliTO now" }] },
  ];
}

// ---------- sync ----------

const SYNC_STATE = { pending: [], closedByUs: [], live: [] };

/**
 * `dash` is the dashboard side (post, close, listCards, agenda, panel, status) and `store` keeps the
 * state between runs: { load(), save(state) }. Both are passed in so tests can fake them.
 */
export function createSync({ polito, dash, store, zone, now = () => new Date(), log: say = () => {} }) {
  const state = { ...SYNC_STATE, ...store.load() };
  // Arrays, so they survive JSON; Sets while working.
  const pending = new Set(state.pending);
  const closedByUs = new Set(state.closedByUs);
  const live = new Set(state.live);
  let running = null;

  function save() {
    try {
      // The oldest ids of cards we closed go first; a few thousand are plenty to remember.
      store.save({ pending: [...pending], closedByUs: [...closedByUs].slice(-2000), live: [...live] });
    } catch (err) {
      say(`polito: saving state failed: ${err.message}`);
    }
  }

  /** Post in batches of 50. One card the dashboard refuses must not hold back the rest. */
  async function postCards(cards) {
    const posted = [];
    for (let i = 0; i < cards.length; i += 50) {
      const chunk = cards.slice(i, i + 50);
      let results;
      try {
        const res = await dash.post(chunk);
        results = res.results ?? [res];
      } catch (err) {
        if (err.status !== 400) throw err;
        results = [];
        for (const card of chunk) {
          try {
            results.push(await dash.post(card));
          } catch (e) {
            say(`polito: the dashboard refused ${card.key}: ${e.message}`);
          }
        }
      }
      posted.push(...results);
    }
    return posted;
  }

  async function markRead(id) {
    try {
      await polito.markRead(id);
      pending.delete(id);
    } catch (err) {
      pending.add(id);
      say(`polito: marking ${id} read failed: ${err.message}`);
    }
    save();
  }

  async function run() {
    const unread = await polito.unread();
    const keys = new Set(unread.map((p) => p.id));
    const retry = [];
    const cards = [];
    // Oldest first, so the newest avviso gets the newest card and sorts on top.
    for (const p of unread.toReversed()) {
      // You closed it here but it's still unread there: the mark-read call failed earlier.
      // Only your own closes are retried. A card the sync closed comes back instead, so a feed that
      // briefly left something out can never get it marked read.
      if (pending.has(p.id)) retry.push(p.id);
      else cards.push({ ...politoCard(p, zone), ...(closedByUs.has(p.id) ? { reopen: true } : {}) });
    }
    for (const id of pending) if (!keys.has(id)) pending.delete(id);

    try {
      for (const r of await postCards(cards)) {
        if (!r.key) continue;
        closedByUs.delete(r.key);
        // An ignored post means the card is closed and stays closed.
        if (!r.ignored) live.add(r.key);
      }

      // Read in the PoliTO app (or on the Portale) since the last check. The list is capped at 500, so
      // the keys we remember cover the rest.
      const listed = [...(await dash.listCards("open")).items, ...(await dash.listCards("snoozed")).items].map((c) => c.key);
      for (const key of new Set([...live, ...listed])) {
        if (!key || isDeadlineKey(key) || keys.has(key)) continue;
        try {
          await dash.close(key, "Read on PoliTO");
          closedByUs.add(key);
          live.delete(key);
        } catch (err) {
          if (err.status === 404) live.delete(key);
          else say(`polito: closing ${key} failed: ${err.message}`);
        }
      }

      const today = dayIn(now(), zone);
      const to = addDays(today, AGENDA_DAYS);
      const deadlines = await polito.deadlines(today, to);
      await dash.agenda(agendaEvents(deadlines, today, to), today, to);
      const soon = addDays(today, CARD_DAYS - 1);
      await postCards(deadlines.filter((d) => isDay(d) && d.date.slice(0, 10) >= today && d.date.slice(0, 10) <= soon).map((d) => deadlineCard(d, today)));

      // Last, a few at a time, so a PoliTO outage can't hold up new avvisi.
      for (const id of retry.slice(0, 10)) await markRead(id);

      const week = addDays(today, 7);
      const thisWeek = deadlines.filter((d) => isDay(d) && d.date.slice(0, 10) >= today && d.date.slice(0, 10) < week).length;
      await dash.panel("PoliTO", panelBlocks(deadlines, today));
      const at = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now());
      await dash.status(`${unread.length} unread, ${thisWeek} deadline${thisWeek === 1 ? "" : "s"} this week, checked ${at}`);
    } finally {
      save();
    }
  }

  return {
    /** Bring cards and deadlines in line with PoliTO. Calls that overlap share one run. */
    sync() {
      running ??= run().finally(() => { running = null; });
      return running;
    },
    /** The owner closed a card: mark its avviso or message read on PoliTO. */
    async closed(key) {
      // Cards we closed ourselves are already read on PoliTO.
      if (!key || isDeadlineKey(key) || closedByUs.has(key)) return;
      live.delete(key);
      await markRead(key);
    },
  };
}

// ---------- running ----------

if (process.env.DASH_URL) {
  const polito = new Polito(process.env.AREADIDATTICA_URL ?? "", process.env.AREADIDATTICA_TOKEN ?? "");
  const dash = { post, close, listCards, agenda, panel, status };
  const store = { load: () => memory.load("polito", {}), save: (s) => memory.save("polito", s) };
  const sync = createSync({ polito, dash, store, zone: tz, log });

  const everyMs = Math.max(0.5, Number(settings.everyHours) || 2) * 3_600_000;
  // Wait a few seconds first: areadidattica starts alongside this container.
  let nextAt = Date.now() + 5_000;
  every(30_000, async () => {
    if (Date.now() < nextAt) return;
    try {
      await sync.sync();
      nextAt = Date.now() + everyMs;
    } catch (err) {
      nextAt = Date.now() + Math.min(everyMs, RETRY_MS);
      throw err;
    }
  });

  onAction(async (a) => {
    if (a.type === "closed") {
      await sync.closed(a.key);
      return { ok: true, result: "" };
    }
    if (a.type === "panel") {
      await sync.sync();
      nextAt = Date.now() + everyMs;
      return { ok: true, result: "Checked PoliTO" };
    }
    return { ok: false, result: "PoliTO cards only close, and the panel only checks." };
  });
}
