// Plan my day: fits your to-dos into the free time in your calendar, and puts the plan in your
// calendar only after you approve it. The draft is made here (free slots, plus Jev's guess at how
// long a to-do takes when Todoist doesn't say). A Grok bot, Secretary by default, only works on it
// when you ask for changes or approve it, since only Grok can write to your Google Calendar.

import { settings, read, decide, handoff, post, panel, status, onAction, memory, localNow, addDays, tz, log } from "../../sdk/dashboard.mjs";

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const DEFAULT_MIN = 30;

/** Free stretches of `day` between `from` and `to` (minutes after midnight), around timed events. */
export function freeSlots(events, day, from, to, gap) {
  const busy = events
    .filter((e) => !e.allDay && e.start.length > 10)
    .map((e) => {
      const end = e.end && e.end.length > 10 ? e.end : e.start;
      const s = e.start.slice(0, 10) < day ? 0 : e.start.slice(0, 10) > day ? 1440 : toMin(e.start.slice(11, 16));
      const f = end.slice(0, 10) < day ? 0 : end.slice(0, 10) > day ? 1440 : toMin(end.slice(11, 16));
      // A little air before and after each event.
      return [s - gap, f + gap];
    })
    .filter(([s, f]) => f > from && s < to)
    .sort((a, b) => a[0] - b[0]);
  const slots = [];
  let cur = from;
  for (const [s, f] of busy) {
    if (s > cur) slots.push({ start: cur, end: Math.min(s, to) });
    cur = Math.max(cur, f);
  }
  if (cur < to) slots.push({ start: cur, end: to });
  return slots.filter((x) => x.end - x.start >= 15);
}

/** The to-dos worth doing on `day`: overdue P1 and P2 first, then due that day, then other overdue ones, then P1s without a date. */
export function pickTasks(todos, day) {
  const due = (t) => (t.due ? t.due.slice(0, 10) : "");
  const rank = (t) => {
    const d = due(t);
    if (d && d < day) return t.priority <= 2 ? 0 : 2;
    if (d === day) return 1;
    return 3;
  };
  return todos
    .filter((t) => !t.completedAt && ((due(t) && due(t) <= day) || (!due(t) && t.priority === 1)))
    .sort((a, b) => rank(a) - rank(b) || a.priority - b.priority || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

/** Put each task in the earliest slot it fits, in order; what doesn't fit is listed. */
export function fit(tasks, slots, gap) {
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

export const blockLine = (b) => `${toHHMM(b.start)}-${toHHMM(b.end)} ${b.title}`;

/** A plan written back by the bot: one "HH:MM-HH:MM title" per line. Other lines are ignored. */
export function parsePlan(text) {
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

const DURATION = {
  type: "choice",
  instructions: "How long will the user need for this to-do, done in one sitting?",
  criteria: {
    15: "A quick thing: one message, a call, a payment, an online form or a small errand.",
    30: "A short task: a few messages, a short call, tidying or checking something.",
    60: "About an hour: a focused piece of work, a longer errand, or a repair at home.",
    90: "A long session: real work on a project, an outing, a big errand.",
    120: "Half a day's block: two hours or more of work, or a trip somewhere.",
  },
};

let state = memory.load("state", { plans: {}, estimates: {} });
const save = () => memory.save("state", state);

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

const dayLabel = (day) => new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** Make (or redo) the draft for `day`: tomorrow from the evening, or the rest of today. */
async function draft(day) {
  const now = localNow();
  const today = day === now.day;
  const start = toMin(settings.dayStart || "08:00");
  const end = toMin(settings.dayEnd || "22:00");
  const gap = Number(settings.gap ?? 10);
  // The rest of today starts at the next quarter hour.
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
  const left = p.left.length ? `\n\nDoesn't fit: ${p.left.join("; ")}` : "";
  await post({
    key: `plan:${day}`,
    kind: "choice",
    title: today ? "Your plan for the rest of today" : `Your plan for tomorrow, ${dayLabel(day)}`,
    body: lines.join("\n") + left,
    context: note || `Not in your calendar yet. To change it, tap Write and say how, like "half an hour of rest after the gym". ${settings.bot || "secretary"} redoes the plan.`,
    source: "Plan my day",
    expires: day,
    reopen: true,
    options: p.blocks.length
      ? [{ label: "Put it in my calendar", instruction: `Add these ${p.blocks.length} blocks to your main calendar on ${day}` }, { label: "Skip this day", instruction: "Leave the calendar as it is" }]
      : [{ label: "OK", instruction: "Nothing to do" }],
  });
  await refreshPanel();
}

async function approve(day) {
  const p = state.plans[day];
  const text = [
    `Plan my day: add these blocks to the user's main Google Calendar on ${day} (time zone ${tz}), each as its own event titled with the to-do and shown as busy. Don't move or change anything already in the calendar.`,
    ...p.blocks.map(blockLine),
    "Then report what you added, in one line.",
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
  const busy = events.filter((e) => e.start.slice(0, 10) === day || (e.end && e.end.slice(0, 10) >= day && e.start.slice(0, 10) <= day))
    .map((e) => `${e.allDay ? "all day" : `${e.start.slice(11, 16)}-${(e.end || e.start).slice(11, 16)}`} ${e.title}`);
  const text = [
    `Plan my day: the user wants changes to this draft plan for ${day}. Don't touch the calendar yet.`,
    "Draft:",
    ...p.blocks.map(blockLine),
    ...(p.left.length ? [`Didn't fit: ${p.left.join("; ")}`] : []),
    `Already in the calendar that day: ${busy.join("; ") || "nothing"}.`,
    `The user's note: ${note}`,
    `Report the revised plan as your answer, one block per line, exactly like "09:00-09:30 Title", between ${settings.dayStart || "08:00"} and ${settings.dayEnd || "22:00"}, nothing else.`,
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
  const blocks = days.length
    ? days.map((d) => {
        const p = state.plans[d];
        return { type: "list", items: [{ title: `${d === now.day ? "Today" : dayLabel(d)}: ${say[p.status] ?? p.status}`, sub: p.blocks.map(blockLine).join(" · ").slice(0, 200) || "Nothing placed" }] };
      })
    : [{ type: "text", text: `No plan yet. A draft for tomorrow comes at ${settings.draftAt || "21:00"}.` }];
  blocks.push({ type: "buttons", items: [{ label: "Plan the rest of today" }, { label: "Plan tomorrow" }] });
  await panel("Plan my day", blocks);
  const todayPlan = state.plans[now.day];
  await status(todayPlan ? `Today: ${say[todayPlan.status] ?? todayPlan.status}` : "No plan for today");
}

const dayOfKey = (key) => /^plan:(\d{4}-\d{2}-\d{2})$/.exec(key ?? "")?.[1];

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

/** The evening draft for tomorrow, and the morning one for today when the evening one went unused. */
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
  // Old plans go.
  for (const d of Object.keys(state.plans)) if (d < addDays(now.day, -7)) delete state.plans[d];
}

if (process.env.DASH_URL) {
  onAction(onTap, { onHandoffResult: onResult });
  const tick = () => clock().catch((err) => status(err.message, false).catch(() => {}));
  void refreshPanel().catch(() => {});
  void tick();
  setInterval(tick, 60_000);
}
