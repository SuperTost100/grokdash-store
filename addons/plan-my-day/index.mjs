// Built from src/plan-my-day by build.mjs. Don't edit: change the source and run npm run build.
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
var panel = (title, blocks) => api("PUT", "/api/bot/panel", { title, blocks });
var status = (text, ok = true) => api("PUT", "/api/addon/status", { text: String(text).slice(0, 200), ok });
var read = (what) => api("GET", `/api/bot/read/${what}`);
var decide = (questions, state2) => api("POST", "/api/addon/decide", { questions, state: state2 });
var handoff = (to, text, urgent = false) => api("POST", "/api/bot/handoffs", { to, text, urgent });
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
var polling = null;
function onAction(handler, opts = {}) {
  if (polling) clearInterval(polling);
  const pollMs = opts.pollMs ?? 4e3;
  const onResult2 = opts.onHandoffResult;
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
      for (const h of got.handoffResults ?? []) await onResult2?.(h);
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
function localNow(at = /* @__PURE__ */ new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
var addDays = (day, n) => new Date(Date.parse(day + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// src/plan-my-day/index.mjs
var toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
var toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
var DEFAULT_MIN = 30;
function freeSlots(events, day, from, to, gap) {
  const busy = events.filter((e) => !e.allDay && e.start.length > 10).map((e) => {
    const end = e.end && e.end.length > 10 ? e.end : e.start;
    const s = e.start.slice(0, 10) < day ? 0 : e.start.slice(0, 10) > day ? 1440 : toMin(e.start.slice(11, 16));
    const f = end.slice(0, 10) < day ? 0 : end.slice(0, 10) > day ? 1440 : toMin(end.slice(11, 16));
    return [s - gap, f + gap];
  }).filter(([s, f]) => f > from && s < to).sort((a, b) => a[0] - b[0]);
  const slots = [];
  let cur = from;
  for (const [s, f] of busy) {
    if (s > cur) slots.push({ start: cur, end: Math.min(s, to) });
    cur = Math.max(cur, f);
  }
  if (cur < to) slots.push({ start: cur, end: to });
  return slots.filter((x) => x.end - x.start >= 15);
}
function pickTasks(todos, day) {
  const due = (t) => t.due ? t.due.slice(0, 10) : "";
  const rank = (t) => {
    const d = due(t);
    if (d && d < day) return t.priority <= 2 ? 0 : 2;
    if (d === day) return 1;
    return 3;
  };
  return todos.filter((t) => !t.completedAt && (due(t) && due(t) <= day || !due(t) && t.priority === 1)).sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}
function fit(tasks, slots, gap) {
  const free = slots.map((s) => ({ ...s }));
  const blocks = [];
  const left = [];
  for (const t of tasks) {
    const slot = free.find((s) => s.end - s.start >= t.minutes);
    if (!slot) {
      left.push(t);
      continue;
    }
    blocks.push({ start: slot.start, end: slot.start + t.minutes, title: t.content, id: t.id });
    slot.start += t.minutes + gap;
  }
  return { blocks: blocks.sort((a, b) => a.start - b.start), left };
}
var blockLine = (b) => `${toHHMM(b.start)}-${toHHMM(b.end)} ${b.title}`;
function parsePlan(text) {
  const blocks = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(?:[-*•]\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    if (end > start) blocks.push({ start, end, title: m[5].slice(0, 120) });
  }
  return blocks.sort((a, b) => a.start - b.start);
}
var DURATION = {
  type: "choice",
  instructions: "How long will the user need for this to-do, done in one sitting?",
  criteria: {
    15: "A quick thing: one message, a call, a payment, an online form or a small errand.",
    30: "A short task: a few messages, a short call, tidying or checking something.",
    60: "About an hour: a focused piece of work, a longer errand, or a repair at home.",
    90: "A long session: real work on a project, an outing, a big errand.",
    120: "Half a day's block: two hours or more of work, or a trip somewhere."
  }
};
var state = memory.load("state", { plans: {}, estimates: {} });
var save = () => memory.save("state", state);
async function minutesFor(t) {
  if (t.duration) return Math.max(15, Math.min(240, Number(t.duration)));
  const key = `${t.id}:${t.content}`;
  if (state.estimates[key]) return state.estimates[key];
  try {
    const r = await decide({ minutes: DURATION }, { todo: t.content, project: t.project ?? "", priority: `P${t.priority}` });
    const m = Number(r.answers?.minutes?.choice) || DEFAULT_MIN;
    state.estimates[key] = m;
    return m;
  } catch (err) {
    log("Jev couldn't estimate:", err.message);
    return DEFAULT_MIN;
  }
}
var dayLabel = (day) => (/* @__PURE__ */ new Date(day + "T12:00:00Z")).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
async function draft(day) {
  const now = localNow();
  const today = day === now.day;
  const start = toMin(settings.dayStart || "08:00");
  const end = toMin(settings.dayEnd || "22:00");
  const gap = Number(settings.gap ?? 10);
  const from = today ? Math.max(start, Math.ceil((toMin(now.time) + 5) / 15) * 15) : start;
  if (from >= end - 30) return log(`too late to plan ${day}`);
  const [{ events }, todos] = await Promise.all([read("agenda"), read("todos")]);
  const slots = freeSlots(events, day, from, end, gap);
  const tasks = [];
  for (const t of pickTasks(todos.items ?? [], day).slice(0, 12)) tasks.push({ ...t, minutes: await minutesFor(t) });
  const plan = fit(tasks, slots, gap);
  state.plans[day] = { status: "draft", blocks: plan.blocks, left: plan.left.map((t) => t.content), madeAt: Date.now() };
  save();
  await showDraft(day);
  log(`drafted ${day}: ${plan.blocks.length} blocks, ${plan.left.length} left over`);
}
async function showDraft(day, note = "") {
  const p = state.plans[day];
  const today = day === localNow().day;
  const lines = p.blocks.length ? p.blocks.map(blockLine) : ["Nothing to place: no to-do is due and nothing urgent waits."];
  const left = p.left.length ? `

Doesn't fit: ${p.left.join("; ")}` : "";
  await post({
    key: `plan:${day}`,
    kind: "choice",
    title: today ? "Your plan for the rest of today" : `Your plan for tomorrow, ${dayLabel(day)}`,
    body: lines.join("\n") + left,
    context: note || `Not in your calendar yet. To change it, tap Write and say how, like "half an hour of rest after the gym". ${settings.bot || "secretary"} redoes the plan.`,
    source: "Plan my day",
    expires: day,
    reopen: true,
    options: p.blocks.length ? [{ label: "Put it in my calendar", instruction: `Add these ${p.blocks.length} blocks to your main calendar on ${day}` }, { label: "Skip this day", instruction: "Leave the calendar as it is" }] : [{ label: "OK", instruction: "Nothing to do" }]
  });
  await refreshPanel();
}
async function approve(day) {
  const p = state.plans[day];
  const text = [
    `Plan my day: add these blocks to the user's main Google Calendar on ${day} (time zone ${tz}), each as its own event titled with the to-do and shown as busy. Don't move or change anything already in the calendar.`,
    ...p.blocks.map(blockLine),
    "Then report what you added, in one line."
  ].join("\n");
  const h = await handoff(settings.bot || "secretary", text, day === localNow().day);
  Object.assign(p, { status: "sent", handoff: h.id });
  save();
  await refreshPanel();
  return `Sent to ${settings.bot || "secretary"} for your calendar`;
}
async function revise(day, note) {
  const p = state.plans[day];
  const { events } = await read("agenda");
  const busy = events.filter((e) => e.start.slice(0, 10) === day || e.end && e.end.slice(0, 10) >= day && e.start.slice(0, 10) <= day).map((e) => `${e.allDay ? "all day" : `${e.start.slice(11, 16)}-${(e.end || e.start).slice(11, 16)}`} ${e.title}`);
  const text = [
    `Plan my day: the user wants changes to this draft plan for ${day}. Don't touch the calendar yet.`,
    "Draft:",
    ...p.blocks.map(blockLine),
    ...p.left.length ? [`Didn't fit: ${p.left.join("; ")}`] : [],
    `Already in the calendar that day: ${busy.join("; ") || "nothing"}.`,
    `The user's note: ${note}`,
    `Report the revised plan as your answer, one block per line, exactly like "09:00-09:30 Title", between ${settings.dayStart || "08:00"} and ${settings.dayEnd || "22:00"}, nothing else.`
  ].join("\n");
  const h = await handoff(settings.bot || "secretary", text, true);
  Object.assign(p, { status: "revising", handoff: h.id, note });
  save();
  await refreshPanel();
  return `Asked ${settings.bot || "secretary"} to redo the plan`;
}
async function refreshPanel() {
  const now = localNow();
  const say = { draft: "Draft waiting for you", revising: "Being redone", sent: "On its way to your calendar", done: "In your calendar", skipped: "Skipped" };
  const days = Object.keys(state.plans).filter((d) => d >= now.day).sort().slice(0, 2);
  const blocks = days.length ? days.map((d) => {
    const p = state.plans[d];
    return { type: "list", items: [{ title: `${d === now.day ? "Today" : dayLabel(d)}: ${say[p.status] ?? p.status}`, sub: p.blocks.map(blockLine).join(" \xB7 ").slice(0, 200) || "Nothing placed" }] };
  }) : [{ type: "text", text: `No plan yet. A draft for tomorrow comes at ${settings.draftAt || "21:00"}.` }];
  blocks.push({ type: "buttons", items: [{ label: "Plan the rest of today" }, { label: "Plan tomorrow" }] });
  await panel("Plan my day", blocks);
  const todayPlan = state.plans[now.day];
  await status(todayPlan ? `Today: ${say[todayPlan.status] ?? todayPlan.status}` : "No plan for today");
}
var dayOfKey = (key) => /^plan:(\d{4}-\d{2}-\d{2})$/.exec(key ?? "")?.[1];
async function onTap(a) {
  if (a.type === "panel") {
    const now = localNow();
    await draft(a.label === "Plan tomorrow" ? addDays(now.day, 1) : now.day);
    return { ok: true, result: "Drafted. It's on Today." };
  }
  const day = dayOfKey(a.card?.key ?? a.key);
  if (!day || !state.plans[day]) return a.type === "closed" ? { ok: true } : { ok: false, result: "That plan is gone. Make a new one from the panel." };
  if (a.type === "closed") return { ok: true };
  if (a.type === "choose" && a.label === "Put it in my calendar") return { ok: true, result: await approve(day) };
  if (a.type === "choose") {
    state.plans[day].status = a.label === "Skip this day" ? "skipped" : state.plans[day].status;
    save();
    await refreshPanel();
    return { ok: true, result: a.label === "Skip this day" ? "Skipped" : "OK" };
  }
  if (a.type === "write") return { ok: true, result: await revise(day, a.text) };
  return { ok: false, result: `Plan my day can't do "${a.type}".` };
}
async function onResult(h) {
  const day = Object.keys(state.plans).find((d) => state.plans[d].handoff === h.id);
  if (!day) return;
  const p = state.plans[day];
  if (p.status === "revising") {
    const blocks = h.ok ? parsePlan(h.result) : [];
    if (blocks.length) Object.assign(p, { status: "draft", blocks, left: [] });
    else p.status = "draft";
    save();
    await showDraft(day, blocks.length ? `Redone with your note: "${p.note}". Approve it, or write again.` : `The bot couldn't redo it${h.result ? `: ${h.result}` : ""}. This is the earlier draft.`);
    return;
  }
  p.status = h.ok ? "done" : "draft";
  p.result = h.result;
  save();
  if (!h.ok) await showDraft(day, `It didn't reach your calendar: ${h.result || "no reason given"}. Try again?`);
  await refreshPanel();
}
async function clock() {
  const now = localNow();
  const tomorrow = addDays(now.day, 1);
  if (now.time >= (settings.draftAt || "21:00") && !state.plans[tomorrow]) await draft(tomorrow);
  const p = state.plans[now.day];
  const unused = !p || p.status === "draft";
  if (now.time >= (settings.dayStart || "08:00") && now.time < (settings.dayEnd || "22:00") && unused && !state.morning?.[now.day]) {
    state.morning = { [now.day]: true };
    save();
    await draft(now.day);
  }
  for (const d of Object.keys(state.plans)) if (d < addDays(now.day, -7)) delete state.plans[d];
}
if (process.env.DASH_URL) {
  onAction(onTap, { onHandoffResult: onResult });
  const tick = () => clock().catch((err) => status(err.message, false).catch(() => {
  }));
  void refreshPanel().catch(() => {
  });
  void tick();
  setInterval(tick, 6e4);
}
export {
  blockLine,
  fit,
  freeSlots,
  parsePlan,
  pickTasks
};
