// Built from src/todoist by build.mjs. Don't edit: change the source and run npm run build.
import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);

// sdk/dashboard.mjs
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
var status = (text, ok = true) => api("PUT", "/api/addon/status", { text: String(text).slice(0, 200), ok });
var todos = (list) => api("PUT", "/api/bot/todos", { todos: list });
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

// src/todoist/index.mjs
var BASE2 = "https://api.todoist.com/api/v1";
async function call(method, path, query = {}) {
  const url = new URL(BASE2 + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(15e3) });
  if (!res.ok) throw new Error(`Todoist answered ${res.status} on ${method} ${path}.${res.status === 401 || res.status === 403 ? " Check the API token." : ""}`);
  return res.status === 204 ? null : res.json();
}
async function paged(path, query) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const data = await call("GET", path, { ...query, limit: "200", ...cursor ? { cursor } : {} });
    out.push(...data.results);
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}
function toTodo(t, projects) {
  const minutes = t.duration ? t.duration.unit === "day" ? t.duration.amount * 24 * 60 : t.duration.amount : 0;
  return {
    id: t.id,
    content: t.content.slice(0, 300),
    // The API counts the other way round: 4 is p1.
    priority: `p${5 - t.priority}`,
    due: t.due ? t.due.datetime ?? t.due.date : "",
    dueString: (t.due?.string ?? "").slice(0, 80),
    deadline: t.deadline?.date ?? "",
    project: (projects.get(t.project_id) ?? "").slice(0, 80),
    url: `https://app.todoist.com/app/task/${t.id}`,
    app: "todoist",
    ...minutes ? { duration: minutes } : {}
  };
}
async function sync() {
  const [tasks, projects] = await Promise.all([
    settings.filter ? paged("/tasks/filter", { query: settings.filter }) : paged("/tasks", {}),
    paged("/projects", {}).then((rows) => new Map(rows.map((p) => [p.id, p.name])))
  ]);
  await todos(tasks.slice(0, 500).map((t) => toTodo(t, projects)));
  await status(`${tasks.length} task${tasks.length === 1 ? "" : "s"}, read ${(/* @__PURE__ */ new Date()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TZ })}`);
}
if (process.env.DASH_URL) {
  every(Math.max(1, Number(settings.every) || 2) * 6e4, sync);
  onAction(async (a) => {
    if (a.type !== "complete_todo") return { ok: false, result: "Todoist only completes to-dos." };
    await call("POST", `/tasks/${encodeURIComponent(a.todoId)}/close`);
    log("closed", a.todoId);
    await sync();
    return { ok: true, result: "Completed in Todoist" };
  });
}
export {
  toTodo
};
