// Built from src/polito by build.mjs. Don't edit: change the source and run npm run build.
import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);

// sdk/dashboard.mjs
import fs from "node:fs";
import path from "node:path";
var BASE = (process.env.DASH_URL ?? "").replace(/\/+$/, "");
var TOKEN = process.env.DASH_TOKEN ?? "";
var settings = JSON.parse(process.env.ADDON_SETTINGS || "{}");
var id = process.env.ADDON_ID ?? "";
var dataDir = process.env.ADDON_DATA ?? "/data";
var tz = process.env.TZ || "UTC";
var DashboardError = class extends Error {
  constructor(status2, message) {
    super(message);
    this.status = status2;
  }
};
async function api(method, route, body) {
  if (!BASE || !TOKEN) throw new Error("DASH_URL and DASH_TOKEN are missing: the dashboard starts add-ons with them.");
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...body !== void 0 ? { "Content-Type": "application/json" } : {} },
    body: body !== void 0 ? JSON.stringify(body) : void 0,
    signal: AbortSignal.timeout(6e4)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DashboardError(res.status, data.error ?? `The dashboard answered ${res.status} on ${method} ${route}`);
  return data;
}
var post = (cards) => api("POST", "/api/bot/items", Array.isArray(cards) ? { items: cards } : cards);
var close = (key, reason = "") => api("POST", "/api/bot/items/close", { key, reason });
var listCards = (status2 = "open") => api("GET", `/api/bot/items?status=${status2}`);
var panel = (title, blocks) => api("PUT", "/api/bot/panel", { title, blocks });
var status = (text, ok = true) => api("PUT", "/api/addon/status", { text: String(text).slice(0, 200), ok });
var agenda = (events, from, to) => api("PUT", "/api/bot/agenda", { events, from, to });
var memory = {
  load(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), "utf8"));
    } catch {
      return fallback;
    }
  },
  save(name, value) {
    const file = path.join(dataDir, `${name}.json`);
    fs.writeFileSync(file + ".tmp", JSON.stringify(value));
    fs.renameSync(file + ".tmp", file);
  }
};
var log = (...args) => console.log((/* @__PURE__ */ new Date()).toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }), ...args);
var readers = [];
function every(ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log("failed:", err.message);
      await status(err.message, false).catch(() => {
      });
    } finally {
      running = false;
    }
  };
  readers.push(tick);
  void tick();
  setTimeout(() => {
    if (!polling) onAction(async () => ({ ok: false, result: "This add-on takes no taps." }));
  }, 0);
  return setInterval(tick, ms);
}
var polling = null;
function onAction(handler, opts = {}) {
  if (polling) clearInterval(polling);
  const pollMs = opts.pollMs ?? 4e3;
  const onResult = opts.onHandoffResult;
  const onHandoff = opts.onHandoff;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const got = await api("GET", "/api/bot/actions");
      for (const a of got.actions ?? []) {
        let ok = true;
        let result = "";
        if (a.type === "refresh") {
          await opts.onRefresh?.();
          await Promise.all(readers.map((r) => r()));
          await api("POST", `/api/bot/actions/${a.id}`, { ok: true, result: "Read" }).catch(() => {
          });
          continue;
        }
        try {
          const r = await handler(a);
          if (r && typeof r === "object") ({ ok = true, result = "" } = r);
        } catch (err) {
          ok = false;
          result = err.message;
        }
        await api("POST", `/api/bot/actions/${a.id}`, { ok, result: String(result).slice(0, 500) }).catch((e) => log("report failed:", e.message));
      }
      for (const h of got.handoffResults ?? []) await onResult?.(h);
      for (const h of got.handoffs ?? []) {
        let ok = true;
        let result = "";
        try {
          result = await onHandoff?.(h) ?? "";
        } catch (err) {
          ok = false;
          result = err.message;
        }
        await api("POST", `/api/bot/handoffs/${h.id}`, { ok, result: String(result).slice(0, 2e3) }).catch(() => {
        });
      }
    } catch (err) {
      if (err.status !== 401) log("actions failed:", err.message);
    } finally {
      busy = false;
    }
  };
  void tick();
  polling = setInterval(tick, pollMs);
  return polling;
}

// src/polito/index.mjs
var APP = "polito";
var BODY_MAX = 2e3;
var AGENDA_DAYS = 30;
var CARD_DAYS = 3;
var DEADLINE_KEY = "deadline-card:";
var PANEL_DEADLINES = 8;
var RETRY_MS = 10 * 6e4;
var isDeadlineKey = (key) => String(key ?? "").startsWith(DEADLINE_KEY);
var addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
var dayIn = (at, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at);
var isDay = (d) => /^\d{4}-\d{2}-\d{2}/.test(d.date);
var httpLink = (u) => u && /^https?:\/\//i.test(u) ? u : "";
var Polito = class {
  constructor(base, token, fetchImpl = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }
  // A cold /items call fetches every course's notices one at a time, so reads get a minute.
  async call(method, path2, timeoutMs = 6e4) {
    const res = await this.fetch(this.base + path2, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const detail = await res.json().then((b) => b.error ?? "", () => "");
      const hint = res.status === 401 ? " Check the token setting." : "";
      throw new Error(`areadidattica answered ${res.status} on ${method} ${path2}${detail ? `: ${detail}` : ""}.${hint}`);
    }
    return res.json();
  }
  async unread() {
    return (await this.call("GET", "/items?unread=true")).items;
  }
  async deadlines(from, to) {
    return (await this.call("GET", `/deadlines?from=${from}&to=${to}`)).deadlines;
  }
  async markRead(id2) {
    await this.call("POST", `/items/${encodeURIComponent(id2)}/read`, 15e3);
  }
};
var GREETING = /^(buongiorno|buonasera|salve|ciao|gentil[ei]|car[eio]|egregi|dear|hello|hi)\b/i;
function split(text) {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l && !l.includes("	") && !(l.length < 40 && GREETING.test(l))) ?? "";
  if (!line) return { title: "", body: text.trim() };
  if (line.length <= 140) return { title: line, body: text.slice(text.indexOf(line) + line.length).trim() };
  const cut = line.slice(0, 140);
  return { title: cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : 139).trimEnd() + "\u2026", body: text.trim() };
}
function fit(body) {
  if (body.length <= BODY_MAX) return body;
  const cut = body.slice(0, BODY_MAX - 1);
  const line = cut.lastIndexOf("\n");
  return (line > BODY_MAX / 2 ? cut.slice(0, line) : cut).trimEnd() + "\u2026";
}
function politoCard(p, zone) {
  const sent = new Date(p.sentAt);
  const { title, body } = split(p.text);
  return {
    key: p.id,
    section: "needs",
    kind: "reminder",
    title: title || p.title.slice(0, 200),
    body: fit(body),
    // The card's own time is when the dashboard first saw it, so say when PoliTO sent it.
    context: Number.isNaN(sent.getTime()) ? "" : `${p.kind === "avviso" ? "Avviso" : "Messaggio"} del ${sent.toLocaleString("it-IT", { timeZone: zone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`,
    source: `PoliTO \xB7 ${p.course ?? (p.kind === "message" ? "Messaggi" : "Avvisi")}`.slice(0, 120),
    app: APP,
    link: httpLink(p.sourceUrl),
    urgent: p.urgent ? "Emergenza" : ""
  };
}
var daysUntil = (day, today) => Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 864e5);
var weekday = (day) => (/* @__PURE__ */ new Date(day + "T12:00:00Z")).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
function dueLabel(day, today) {
  const days = daysUntil(day, today);
  return days <= 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due ${weekday(day)}`;
}
function deadlineCard(d, today) {
  const day = d.date.slice(0, 10);
  return {
    key: `${DEADLINE_KEY}${d.id}`,
    section: "needs",
    kind: "reminder",
    title: d.title.slice(0, 200),
    body: [d.course, d.type].filter(Boolean).join(" \xB7 "),
    source: `PoliTO \xB7 ${d.course ?? "Scadenze"}`.slice(0, 120),
    app: APP,
    link: httpLink(d.url),
    urgent: dueLabel(day, today),
    // A day without a time runs out at the end of that day.
    expires: day
  };
}
function agendaEvents(deadlines, from, to) {
  return deadlines.filter((d) => isDay(d) && d.date.slice(0, 10) >= from && d.date.slice(0, 10) < to).map((d) => ({ title: d.title.slice(0, 200), start: d.date.slice(0, 10), end: "", location: "", allDay: true, app: APP }));
}
function panelBlocks(deadlines, today) {
  const next = deadlines.filter((d) => isDay(d) && d.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const items = next.slice(0, PANEL_DEADLINES).map((d) => {
    const day = d.date.slice(0, 10);
    const days = daysUntil(day, today);
    return {
      title: d.title.slice(0, 200),
      sub: [d.course, d.type].filter(Boolean).join(" \xB7 ").slice(0, 200),
      badge: days <= 0 ? "Today" : days === 1 ? "Tomorrow" : (/* @__PURE__ */ new Date(day + "T12:00:00Z")).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
      link: httpLink(d.url)
    };
  });
  return [
    items.length ? { type: "list", items } : { type: "text", text: `No deadlines in the next ${AGENDA_DAYS} days.` },
    { type: "buttons", items: [{ label: "Check now", instruction: "Check PoliTO now" }] }
  ];
}
var SYNC_STATE = { pending: [], closedByUs: [], live: [] };
function createSync({ polito, dash, store, zone, now = () => /* @__PURE__ */ new Date(), log: say = () => {
} }) {
  const state = { ...SYNC_STATE, ...store.load() };
  const pending = new Set(state.pending);
  const closedByUs = new Set(state.closedByUs);
  const live = new Set(state.live);
  let running = null;
  function save() {
    try {
      store.save({ pending: [...pending], closedByUs: [...closedByUs].slice(-2e3), live: [...live] });
    } catch (err) {
      say(`polito: saving state failed: ${err.message}`);
    }
  }
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
  async function markRead(id2) {
    try {
      await polito.markRead(id2);
      pending.delete(id2);
    } catch (err) {
      pending.add(id2);
      say(`polito: marking ${id2} read failed: ${err.message}`);
    }
    save();
  }
  async function run() {
    const unread = await polito.unread();
    const keys = new Set(unread.map((p) => p.id));
    const retry = [];
    const cards = [];
    for (const p of unread.toReversed()) {
      if (pending.has(p.id)) retry.push(p.id);
      else cards.push({ ...politoCard(p, zone), ...closedByUs.has(p.id) ? { reopen: true } : {} });
    }
    for (const id2 of pending) if (!keys.has(id2)) pending.delete(id2);
    try {
      for (const r of await postCards(cards)) {
        if (!r.key) continue;
        closedByUs.delete(r.key);
        if (!r.ignored) live.add(r.key);
      }
      const listed = [...(await dash.listCards("open")).items, ...(await dash.listCards("snoozed")).items].map((c) => c.key);
      for (const key of /* @__PURE__ */ new Set([...live, ...listed])) {
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
      for (const id2 of retry.slice(0, 10)) await markRead(id2);
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
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
    /** The owner closed a card: mark its avviso or message read on PoliTO. */
    async closed(key) {
      if (!key || isDeadlineKey(key) || closedByUs.has(key)) return;
      live.delete(key);
      await markRead(key);
    }
  };
}
if (process.env.DASH_URL) {
  const polito = new Polito(process.env.AREADIDATTICA_URL ?? "", process.env.AREADIDATTICA_TOKEN ?? "");
  const dash = { post, close, listCards, agenda, panel, status };
  const store = { load: () => memory.load("polito", {}), save: (s) => memory.save("polito", s) };
  const sync = createSync({ polito, dash, store, zone: tz, log });
  const everyMs = Math.max(0.5, Number(settings.everyHours) || 2) * 36e5;
  let nextAt = Date.now() + 5e3;
  every(3e4, async () => {
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
  }, { onRefresh: () => {
    nextAt = 0;
  } });
}
export {
  Polito,
  agendaEvents,
  createSync,
  deadlineCard,
  dueLabel,
  isDeadlineKey,
  panelBlocks,
  politoCard,
  split
};
