// Todoist: your to-dos on Today, ticked off from the dashboard.
// Reads the active tasks every few minutes and closes a task when you tick it on the page.

import { settings, todos, status, onAction, every, log } from "../../sdk/dashboard.mjs";

const BASE = "https://api.todoist.com/api/v1";

async function call(method, path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Todoist answered ${res.status} on ${method} ${path}.${res.status === 401 || res.status === 403 ? " Check the API token." : ""}`);
  return res.status === 204 ? null : res.json();
}

async function paged(path, query) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const data = await call("GET", path, { ...query, limit: "200", ...(cursor ? { cursor } : {}) });
    out.push(...data.results);
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

/** Todoist's task, as the dashboard's to-do. */
export function toTodo(t, projects) {
  const minutes = t.duration ? (t.duration.unit === "day" ? t.duration.amount * 24 * 60 : t.duration.amount) : 0;
  return {
    id: t.id,
    content: t.content.slice(0, 300),
    // The API counts the other way round: 4 is p1.
    priority: `p${5 - t.priority}`,
    due: t.due ? (t.due.datetime ?? t.due.date) : "",
    dueString: (t.due?.string ?? "").slice(0, 80),
    deadline: t.deadline?.date ?? "",
    project: (projects.get(t.project_id) ?? "").slice(0, 80),
    url: `https://app.todoist.com/app/task/${t.id}`,
    app: "todoist",
    ...(minutes ? { duration: minutes } : {}),
  };
}

async function sync() {
  const [tasks, projects] = await Promise.all([
    settings.filter ? paged("/tasks/filter", { query: settings.filter }) : paged("/tasks", {}),
    paged("/projects", {}).then((rows) => new Map(rows.map((p) => [p.id, p.name]))),
  ]);
  await todos(tasks.slice(0, 500).map((t) => toTodo(t, projects)));
  await status(`${tasks.length} task${tasks.length === 1 ? "" : "s"}, read ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TZ })}`);
}

if (process.env.DASH_URL) {
  every(Math.max(1, Number(settings.every) || 2) * 60_000, sync);
  onAction(async (a) => {
    if (a.type !== "complete_todo") return { ok: false, result: "Todoist only completes to-dos." };
    await call("POST", `/tasks/${encodeURIComponent(a.todoId)}/close`);
    log("closed", a.todoId);
    // Read again at once, so a recurring task shows its next date.
    await sync();
    return { ok: true, result: "Completed in Todoist" };
  });
}
