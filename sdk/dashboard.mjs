// The add-on SDK: everything an add-on or an app's adapter needs to talk to the Grok Bot Dashboard.
// It's bundled into each add-on at build time, so an add-on is one file with no dependencies to install.
//
// The dashboard starts an add-on with DASH_URL, DASH_TOKEN, ADDON_ID, ADDON_DATA (a folder it may write)
// and ADDON_SETTINGS (JSON). An app's containers marked "x-dashboard" get the same values.

import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.DASH_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.DASH_TOKEN ?? "";

/** The settings you filled in on the Add-ons page, with the defaults from addon.json. */
export const settings = JSON.parse(process.env.ADDON_SETTINGS || "{}");
export const id = process.env.ADDON_ID ?? "";
export const dataDir = process.env.ADDON_DATA ?? "/data";
export const tz = process.env.TZ || "UTC";

export class DashboardError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Call the dashboard. Throws DashboardError with the dashboard's own message when it says no. */
export async function api(method, route, body) {
  if (!BASE || !TOKEN) throw new Error("DASH_URL and DASH_TOKEN are missing: the dashboard starts add-ons with them.");
  const res = await fetch(BASE + route, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DashboardError(res.status, data.error ?? `The dashboard answered ${res.status} on ${method} ${route}`);
  return data;
}

/** Post cards: one, or a list (up to 50). The same key updates a card. */
export const post = (cards) => api("POST", "/api/bot/items", Array.isArray(cards) ? { items: cards } : cards);
export const close = (key, reason = "") => api("POST", "/api/bot/items/close", { key, reason });
export const listCards = (status = "open") => api("GET", `/api/bot/items?status=${status}`);
/** Replace your panel: { title, blocks: [...] }. See the dashboard's docs/API.md for the blocks. */
export const panel = (title, blocks) => api("PUT", "/api/bot/panel", { title, blocks });
/** One line on the Add-ons page, like "Read 2 min ago" or what went wrong. */
export const status = (text, ok = true) => api("PUT", "/api/addon/status", { text: String(text).slice(0, 200), ok });
/** Replace your events between two days (YYYY-MM-DD, `to` not included). */
export const agenda = (events, from, to) => api("PUT", "/api/bot/agenda", { events, from, to });
/** Replace your to-do list. */
export const todos = (list) => api("PUT", "/api/bot/todos", { todos: list });
/** Trusted only: what the user allowed you to read ("agenda", "todos" or "cards"). */
export const read = (what) => api("GET", `/api/bot/read/${what}`);
/** Trusted only: mail and chat messages the dashboard received, after the id you last saw. */
export const readMessages = (after = 0, source = "", limit = 200) =>
  api("GET", `/api/addon/messages?after=${after}&limit=${limit}${source ? `&source=${encodeURIComponent(source)}` : ""}`);
/** Trusted only: send messages you read to triage. `sources` names each source id once. */
export const sendMessages = (sources, messages) => api("POST", "/api/addon/messages", { sources, messages });
/** Trusted only: typed questions for Jev, paid from the dashboard's OpenRouter key. */
export const decide = (questions, state) => api("POST", "/api/addon/decide", { questions, state });
/** Trusted only: leave work for a Grok bot. Its answer comes back through onHandoffResult. */
export const handoff = (to, text, urgent = false) => api("POST", "/api/bot/handoffs", { to, text, urgent });

/** Small JSON files in your data folder, for cursors and caches. */
export const memory = {
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
  },
};

export const log = (...args) => console.log(new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour12: false }), ...args);

const readers = [];

/** Run fn now and then every `ms`. A failure shows as the add-on's status and is tried again next time. Refresh on the page runs it at once. */
export function every(ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log("failed:", err.message);
      await status(err.message, false).catch(() => {});
    } finally {
      running = false;
    }
  };
  readers.push(tick);
  void tick();
  // An add-on that takes no taps still answers Refresh: poll for actions anyway.
  setTimeout(() => { if (!polling) onAction(async () => ({ ok: false, result: "This add-on takes no taps." })); }, 0);
  return setInterval(tick, ms);
}

let polling = null;

/**
 * Handle taps on your cards and panel, and cards the user closed. `handler(action)` returns
 * { ok, result } or nothing (counts as done); throwing reports a failure with the error's message.
 * Action types: choose, send, write, panel, complete_todo, closed ({ key, reason }). Refresh on the
 * page is handled here: `opts.onRefresh` runs, then every function given to `every()`.
 */
export function onAction(handler, opts = {}) {
  if (polling) clearInterval(polling);
  const pollMs = opts.pollMs ?? 4000;
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
        // Refresh on the page: read now, whatever the handler does.
        if (a.type === "refresh") {
          await opts.onRefresh?.();
          await Promise.all(readers.map((r) => r()));
          await api("POST", `/api/bot/actions/${a.id}`, { ok: true, result: "Read" }).catch(() => {});
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
          result = (await onHandoff?.(h)) ?? "";
        } catch (err) {
          ok = false;
          result = err.message;
        }
        await api("POST", `/api/bot/handoffs/${h.id}`, { ok, result: String(result).slice(0, 2000) }).catch(() => {});
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

/** Today's date (YYYY-MM-DD) and the time (HH:MM) in the dashboard's time zone. */
export function localNow(at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export const addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
