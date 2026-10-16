import { test } from "node:test";
import assert from "node:assert/strict";
import { freeSlots, pickTasks, fit, parsePlan, blockLine } from "../src/plan-my-day/index.mjs";

const day = "2026-10-17";
const ev = (start, end, title = "x") => ({ start: `${day}T${start}:00`, end: `${day}T${end}:00`, title, allDay: false });

test("free time between events, with a break around each, from the start to the end of the day", () => {
  const slots = freeSlots([ev("10:00", "11:00"), ev("16:00", "17:00"), { start: day, end: "", allDay: true, title: "Holiday" }], day, 8 * 60, 22 * 60, 10);
  assert.deepEqual(slots.map((s) => [s.start, s.end]), [[480, 590], [670, 950], [1030, 1320]]);
  const overnight = freeSlots([{ start: "2026-10-16T20:45:00", end: `${day}T10:00:00`, title: "Scout night", allDay: false }], day, 480, 1320, 10);
  assert.deepEqual(overnight[0], { start: 610, end: 1320 }, "an event from the night before still counts");
});

test("what to do that day: overdue P1/P2 first, then due that day, then other overdue, then undated P1", () => {
  const todos = [
    { id: "a", content: "Due today P3", priority: 3, due: day },
    { id: "b", content: "Overdue P4", priority: 4, due: "2026-10-13" },
    { id: "c", content: "Overdue P2", priority: 2, due: "2026-10-14" },
    { id: "d", content: "Next week", priority: 1, due: "2026-10-22" },
    { id: "e", content: "Undated P1", priority: 1, due: "" },
    { id: "f", content: "Undated P3", priority: 3, due: "" },
  ];
  assert.deepEqual(pickTasks(todos, day).map((t) => t.id), ["c", "a", "b", "e"]);
});

test("tasks go in the earliest slot they fit; what doesn't fit is listed", () => {
  const { blocks, left } = fit(
    [{ id: "1", content: "Long", minutes: 120 }, { id: "2", content: "Short", minutes: 30 }, { id: "3", content: "Huge", minutes: 300 }],
    [{ start: 480, end: 590 }, { start: 670, end: 950 }],
    10,
  );
  assert.deepEqual(blocks.map(blockLine), ["08:00-08:30 Short", "11:10-13:10 Long"]);
  assert.deepEqual(left.map((t) => t.content), ["Huge"]);
});

test("a plan the bot writes back is read line by line, and only lines that look like blocks count", () => {
  const blocks = parsePlan("Here you go:\n09:00-09:30 Rispondere a CFR\n- 17:00–17:30 Riposo dopo la palestra\n18.00-19.30 Riparazione tapparelle\n25:00-26:00 nonsense");
  assert.deepEqual(blocks.map(blockLine), ["09:00-09:30 Rispondere a CFR", "17:00-17:30 Riposo dopo la palestra", "18:00-19:30 Riparazione tapparelle"]);
});
