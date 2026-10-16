import { test } from "node:test";
import assert from "node:assert/strict";
import { toTodo } from "../src/todoist/index.mjs";

test("Todoist tasks as the dashboard's to-dos: p1 the right way round, UTC times passed on, durations in minutes", () => {
  const projects = new Map([["p", "Work"]]);
  const a = toTodo({ id: "a", content: "Urgent", priority: 4, project_id: "p", due: null, deadline: { date: "2026-10-13" }, duration: { amount: 90, unit: "minute" } }, projects);
  assert.deepEqual([a.priority, a.deadline, a.project, a.duration, a.app], ["p1", "2026-10-13", "Work", 90, "todoist"]);
  const d = toTodo({ id: "d", content: "Late night", priority: 1, project_id: "x", due: { date: "2026-10-12", datetime: "2026-10-12T22:30:00Z", string: "every day" } }, projects);
  assert.deepEqual([d.priority, d.due, d.dueString, d.project, "duration" in d], ["p4", "2026-10-12T22:30:00Z", "every day", "", false]);
  assert.equal(toTodo({ id: "e", content: "Trip", priority: 2, project_id: "p", due: { date: "2026-10-20" }, duration: { amount: 1, unit: "day" } }, projects).duration, 1440);
  assert.equal(d.url, "https://app.todoist.com/app/task/d");
});
