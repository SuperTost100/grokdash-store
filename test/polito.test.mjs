import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Polito, createSync, politoCard, deadlineCard, dueLabel, split, agendaEvents, panelBlocks, isDeadlineKey } from "../src/polito/index.mjs";

const TZ = "Europe/Rome";
const CLOCK = new Date("2026-10-13T09:00:00Z");

const avviso = (id, text, extra = {}) => ({
  id: `notification:${id}`, kind: "avviso", course: "Analisi matematica II", title: "Nuovo avviso nel Corso di Analisi matematica II",
  text, sentAt: "2026-10-09T15:41:45+02:00", isRead: false, urgent: false, sourceUrl: null, ...extra,
});

/** A stand-in for areadidattica: unread items, deadlines, and the reads it was asked for. */
function fakeAreadidattica() {
  const fake = {
    unread: [],
    deadlines: [],
    reads: [],
    down: false,
    auth: [],
    fetch: async (input, init) => {
      const u = new URL(String(input));
      fake.auth.push(String(new Headers(init?.headers).get("authorization")));
      const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (fake.down) return json({ error: "PoliTO login paused" }, 502);
      if (u.pathname === "/items" && u.searchParams.get("unread") === "true") return json({ items: fake.unread });
      if (u.pathname === "/deadlines") return json({ deadlines: fake.deadlines });
      const read = /^\/items\/([^/]+)\/read$/.exec(u.pathname);
      if (read && init?.method === "POST") {
        const id = decodeURIComponent(read[1]);
        fake.reads.push(id);
        fake.unread = fake.unread.filter((i) => i.id !== id);
        return json({ ok: true, id });
      }
      return json({ error: "not found" }, 404);
    },
  };
  return fake;
}

/** A stand-in for the dashboard's bot API: the rules for keys, reopen, closing and the 500 cap on lists. */
function fakeDashboard() {
  const d = {
    cards: new Map(),
    events: [],
    window: null,
    shownPanel: null,
    shownStatus: null,
    posts: 0,
    refuse: new Set(),
    async post(input) {
      d.posts++;
      const batch = Array.isArray(input);
      const list = batch ? input : [input];
      if (list.length > 50) throw Object.assign(new Error("Send at most 50 items per call."), { status: 400 });
      const results = list.map((c) => {
        if (d.refuse.has(c.key) || c.body?.length > 2000) throw Object.assign(new Error(`${c.key} refused`), { status: 400 });
        const old = d.cards.get(c.key);
        if (old?.status === "closed" && !c.reopen) return { key: c.key, status: "closed", ignored: true };
        d.cards.set(c.key, { ...c, status: old && old.status !== "closed" ? old.status : "open", closedReason: "" });
        return { key: c.key, status: "open", created: !old, reopened: old?.status === "closed", ignored: false };
      });
      return batch ? { results } : results[0];
    },
    async close(key, reason) {
      const c = d.cards.get(key);
      if (!c) throw Object.assign(new Error("No item with that id or key for this bot."), { status: 404 });
      Object.assign(c, { status: "closed", closedReason: "bot", resolution: reason });
      return { status: "closed" };
    },
    async listCards(status) {
      const rows = [...d.cards.values()].filter((c) => c.status === status).reverse().slice(0, 500);
      return { items: rows.map((c) => ({ key: c.key, status: c.status })) };
    },
    async agenda(events, from, to) {
      for (const e of events) assert.ok(e.start >= from && e.start < to, `${e.start} is outside ${from} to ${to}`);
      d.events = events;
      d.window = [from, to];
    },
    async panel(title, blocks) { d.shownPanel = { title, blocks }; },
    async status(text, ok = true) { d.shownStatus = { text, ok }; },
    /** What the owner does on the page: closes a card, which the dashboard reports as a "closed" action. */
    userClose(key) { Object.assign(d.cards.get(key), { status: "closed", closedReason: "dismissed" }); },
    open: () => [...d.cards.values()].filter((c) => c.status === "open").map((c) => c.key),
  };
  return d;
}

function setup() {
  const fake = fakeAreadidattica();
  const dash = fakeDashboard();
  const logs = [];
  let saved = {};
  const store = { load: () => saved, save: (s) => { saved = JSON.parse(JSON.stringify(s)); } };
  const client = new Polito("http://polito-areadidattica:8789/", "secret", (i, o) => fake.fetch(i, o));
  const make = () => createSync({ polito: client, dash, store, zone: TZ, now: () => CLOCK, log: (m) => logs.push(m) });
  return { fake, dash, logs, sync: make(), restart: make, state: () => saved };
}

test("unread avvisi become cards in their own language, deadlines go on the agenda", async () => {
  const t = setup();
  t.fake.unread = [
    avviso(1, "Gentili studenti,\n\nmercoledì 14 ottobre la lezione è spostata in aula 7T.\nA presto"),
    avviso(2, "", { id: "message:9", kind: "message", course: null, title: "Chiusura sedi", urgent: true }),
  ];
  t.fake.deadlines = [{ id: "deadline:a", title: "Pagamento seconda rata", date: "2026-10-14", course: null, type: "Tasse", url: null }];
  await t.sync.sync();
  const a = t.dash.cards.get("notification:1");
  assert.equal(a.title, "mercoledì 14 ottobre la lezione è spostata in aula 7T.", "skips the greeting");
  assert.equal(a.body, "A presto", "doesn't repeat the title");
  assert.equal(a.source, "PoliTO · Analisi matematica II");
  assert.equal(a.app, "polito");
  assert.match(a.context, /^Avviso del 9 ottobre/);
  const m = t.dash.cards.get("message:9");
  assert.equal(m.title, "Chiusura sedi", "no text: PoliTO's own title");
  assert.equal(m.urgent, "Emergenza");
  assert.deepEqual(t.dash.events.map((e) => [e.title, e.start, e.allDay, e.app]), [["Pagamento seconda rata", "2026-10-14", true, "polito"]]);
  assert.deepEqual(t.dash.window, ["2026-10-13", "2026-11-12"]);
  assert.ok(t.fake.auth.every((h) => h === "Bearer secret"));
  assert.equal(t.dash.shownStatus.text, "2 unread, 1 deadline this week, checked 11:00");
});

test("the status says what is waiting, and the panel lists the next deadlines with a Check now button", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due"), avviso(3, "Tre"), avviso(4, "Quattro")];
  t.fake.deadlines = [
    { id: "d:b", title: "Esame di Fisica", date: "2026-10-30", course: "Fisica I", type: "Esame", url: "https://example.com/x" },
    { id: "d:a", title: "Consegna laboratorio", date: "2026-10-14", course: "Fisica I", type: "Esercitazione", url: null },
    { id: "d:c", title: "Seconda rata", date: "2026-10-19", course: null, type: "Tasse", url: null },
  ];
  await t.sync.sync();
  assert.equal(t.dash.shownStatus.text, "4 unread, 2 deadlines this week, checked 11:00");
  assert.equal(t.dash.shownPanel.title, "PoliTO");
  const [list, buttons] = t.dash.shownPanel.blocks;
  assert.deepEqual(list.items.map((i) => [i.title, i.badge, i.sub]), [
    ["Consegna laboratorio", "Tomorrow", "Fisica I · Esercitazione"],
    ["Seconda rata", "Mon 19 Oct", "Tasse"],
    ["Esame di Fisica", "Fri 30 Oct", "Fisica I · Esame"],
  ]);
  assert.equal(list.items[2].link, "https://example.com/x");
  assert.deepEqual(buttons, { type: "buttons", items: [{ label: "Check now", instruction: "Check PoliTO now" }] });
  assert.deepEqual(panelBlocks([], "2026-10-13")[0], { type: "text", text: "No deadlines in the next 30 days." });
});

test("closing a card marks the avviso read on PoliTO, and it doesn't come back", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due")];
  await t.sync.sync();
  t.dash.userClose("notification:1");
  await t.sync.closed("notification:1");
  t.dash.userClose("notification:2");
  await t.sync.closed("notification:2");
  assert.deepEqual(t.fake.reads, ["notification:1", "notification:2"]);
  await t.sync.sync();
  assert.equal(t.dash.cards.get("notification:1").status, "closed");
  assert.equal(t.dash.cards.get("notification:2").closedReason, "dismissed");
});

test("a read that failed is retried by the next check", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.dash.userClose("notification:1");
  t.fake.down = true;
  await t.sync.closed("notification:1");
  assert.deepEqual(t.fake.reads, []);
  assert.ok(t.logs.some((l) => l.includes("marking notification:1 read failed")));
  t.fake.down = false;
  await t.sync.sync();
  assert.deepEqual(t.fake.reads, ["notification:1"]);
  assert.equal(t.dash.cards.get("notification:1").status, "closed", "the closed card stayed closed");
});

test("a failed read is still retried after the adapter restarts", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.dash.userClose("notification:1");
  t.fake.down = true;
  await t.sync.closed("notification:1");
  t.fake.down = false;
  await t.restart().sync();
  assert.deepEqual(t.fake.reads, ["notification:1"]);
});

test("avvisi read in the phone app close here, snoozed ones too", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due"), avviso(3, "Tre")];
  await t.sync.sync();
  // Snoozed cards are not "open" to the list, but they are still live.
  t.dash.cards.get("notification:2").status = "snoozed";
  t.fake.unread = [avviso(3, "Tre")];
  await t.sync.sync();
  for (const k of ["notification:1", "notification:2"]) {
    const c = t.dash.cards.get(k);
    assert.equal(c.status, "closed", k);
    assert.equal(c.resolution, "Read on PoliTO");
  }
  assert.equal(t.dash.cards.get("notification:3").status, "open");
  assert.deepEqual(t.fake.reads, [], "nothing to mark read");
});

test("an avviso missing from one check comes back unread, and is never marked read for you", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.fake.unread = [];
  await t.sync.sync();
  assert.equal(t.dash.cards.get("notification:1").status, "closed");
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  assert.equal(t.dash.cards.get("notification:1").status, "open");
  assert.deepEqual(t.fake.reads, []);
  // The same after a restart: what the sync closed is remembered.
  t.fake.unread = [];
  await t.sync.sync();
  t.fake.unread = [avviso(1, "Uno")];
  await t.restart().sync();
  assert.equal(t.dash.cards.get("notification:1").status, "open");
  assert.deepEqual(t.fake.reads, []);
});

test("hundreds of cards read elsewhere all close, past the list's 500 cap", async () => {
  const t = setup();
  t.fake.unread = Array.from({ length: 510 }, (_, i) => avviso(i + 1, `Avviso ${i + 1}`));
  await t.sync.sync();
  assert.equal(t.dash.open().length, 510);
  t.fake.unread = [];
  await t.sync.sync();
  assert.equal(t.dash.open().length, 0);
});

test("cards the dashboard already has are found even without remembered state", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.fake.unread = [];
  const fresh = createSync({ polito: new Polito("http://x", "secret", (i, o) => t.fake.fetch(i, o)), dash: t.dash, store: { load: () => ({}), save: () => {} }, zone: TZ, now: () => CLOCK });
  await fresh.sync();
  assert.equal(t.dash.cards.get("notification:1").status, "closed");
});

test("a snoozed avviso still unread stays as it is", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.dash.cards.get("notification:1").status = "snoozed";
  await t.sync.sync();
  assert.equal(t.dash.cards.get("notification:1").status, "snoozed");
});

test("a slow mark-read retry doesn't hold up new avvisi", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.dash.userClose("notification:1");
  t.fake.down = true;
  await t.sync.closed("notification:1");
  t.fake.down = false;
  let release;
  const held = new Promise((r) => { release = r; });
  const before = t.fake.fetch;
  t.fake.fetch = async (input, init) => {
    if (init?.method === "POST") await held;
    return before(input, init);
  };
  t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due")];
  const run = t.sync.sync();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.dash.cards.get("notification:2")?.status, "open", "new card is in before the retry ends");
  release();
  await run;
  assert.deepEqual(t.fake.reads, ["notification:1"]);
});

test("when areadidattica fails, the check throws with the reason and the cards stay", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await t.sync.sync();
  t.fake.down = true;
  await assert.rejects(t.sync.sync(), /areadidattica answered 502 on GET \/items\?unread=true: PoliTO login paused/);
  assert.equal(t.dash.cards.get("notification:1").status, "open");
  t.fake.down = false;
  await t.sync.sync();
});

test("a wrong token says where to look", async () => {
  const t = setup();
  t.fake.fetch = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  await assert.rejects(t.sync.sync(), /answered 401 .*Check the token setting\./);
});

test("overlapping checks share one run", async () => {
  const t = setup();
  t.fake.unread = [avviso(1, "Uno")];
  await Promise.all([t.sync.sync(), t.sync.sync()]);
  assert.equal(t.fake.auth.length, 2, "one /items and one /deadlines call");
});

test("one card the dashboard refuses doesn't hold back the others", async () => {
  const t = setup();
  t.dash.refuse.add("notification:2");
  t.fake.unread = [avviso(1, "Uno"), avviso(2, "Due"), avviso(3, "Tre")];
  await t.sync.sync();
  assert.deepEqual(t.dash.open().sort(), ["notification:1", "notification:3"]);
  assert.ok(t.logs.some((l) => l.includes("refused notification:2")));
});

test("a table keeps one row per line and never becomes the title", () => {
  const rows = ["MATRICOLA\tGiorno\tOra", ...Array.from({ length: 80 }, (_, i) => `${300000 + i}\tLunedì 14\t16:30`)].join("\n");
  const c = politoCard(avviso(1, `${rows}\n\nChi non può presentarsi mi scriva.`), TZ);
  assert.equal(c.title, "Chi non può presentarsi mi scriva.");
  const intro = politoCard(avviso(2, `Buongiorno,\n\necco il calendario degli orali.\n\n${rows}`), TZ);
  assert.equal(intro.title, "ecco il calendario degli orali.");
  assert.ok(intro.body.startsWith("MATRICOLA\tGiorno\tOra\n300000\tLunedì 14\t16:30"));
  assert.ok(intro.body.endsWith("300079\tLunedì 14\t16:30"), "all 80 rows fit");
  // The dashboard takes 2000 characters, so a longer table ends on a whole row.
  const long = politoCard(avviso(3, `Ecco gli orali.\n\n${rows}\n${rows}`), TZ);
  assert.ok(long.body.length <= 2000 && long.body.endsWith("…"));
  assert.match(long.body.split("\n").at(-1), /^\d{6}\tLunedì 14\t16:30…$/);
});

test("long avvisi fit a card", () => {
  const c = politoCard(avviso(1, "x".repeat(150) + " fine\n" + "y".repeat(12_000)), TZ);
  assert.ok(c.title.length <= 141 && c.title.endsWith("…"));
  assert.equal(c.body.length, 2000);
  assert.equal(split("Solo una riga").body, "");
});

test("an avviso link is kept only when it is http(s)", () => {
  assert.equal(politoCard(avviso(1, "Uno", { sourceUrl: "https://didattica.polito.it/x" }), TZ).link, "https://didattica.polito.it/x");
  assert.equal(politoCard(avviso(2, "Due", { sourceUrl: "javascript:alert(1)" }), TZ).link, "");
});

test("a deadline in the next three days is an urgent card that expires that day; nothing is marked read for it", async () => {
  const t = setup();
  t.fake.deadlines = [
    { id: "deadline:a", title: "Consegna laboratorio", date: "2026-10-14", course: "Fisica I", type: "Esercitazione", url: null },
    { id: "deadline:b", title: "Pagamento seconda rata", date: "2026-10-20", course: null, type: "Tasse", url: null },
  ];
  await t.sync.sync();
  const card = t.dash.cards.get("deadline-card:deadline:a");
  assert.deepEqual([card.urgent, card.source, card.expires, card.body], ["Due tomorrow", "PoliTO · Fisica I", "2026-10-14", "Fisica I · Esercitazione"]);
  assert.ok(!t.dash.cards.has("deadline-card:deadline:b"), "a week away: agenda only");
  assert.equal(t.dash.events.length, 2);
  await t.sync.sync();
  assert.equal(t.dash.cards.get("deadline-card:deadline:a").status, "open", "an avvisi sync doesn't close it");
  t.dash.userClose("deadline-card:deadline:a");
  await t.sync.closed("deadline-card:deadline:a");
  assert.deepEqual(t.fake.reads, []);
  await t.sync.sync();
  assert.equal(t.dash.cards.get("deadline-card:deadline:a").status, "closed", "a card you closed stays closed");
});

test("deadline labels and the agenda window", () => {
  assert.deepEqual(["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-12"].map((d) => dueLabel(d, "2026-10-13")), ["Due today", "Due tomorrow", "Due Thursday", "Due today"]);
  assert.equal(deadlineCard({ id: "x", title: "T", date: "2026-10-13T23:59:00Z", course: null, type: null, url: "ftp://x" }, "2026-10-13").link, "");
  // The window's last day isn't part of it, and a deadline without a date has no place on the agenda.
  const events = agendaEvents([
    { id: "1", title: "A", date: "2026-10-13" }, { id: "2", title: "B", date: "2026-11-12" }, { id: "3", title: "C", date: "bis" }, { id: "4", title: "D", date: "2026-11-11T10:00:00Z" },
  ], "2026-10-13", "2026-11-12");
  assert.deepEqual(events.map((e) => e.title), ["A", "D"]);
  assert.ok(isDeadlineKey("deadline-card:x") && !isDeadlineKey("notification:1"));
});

test("the compose file passes the runner's rules", async (t) => {
  const file = "/home/tost/.t3/worktrees/Grog-Bot-Dashboard/t3-5dfa18aa/runner/validate.mjs";
  if (!fs.existsSync(file)) return t.skip("the dashboard checkout isn't here");
  const { checkCompose, fillVars } = await import(file);
  const compose = JSON.parse(fs.readFileSync(new URL("../apps/polito/compose.json", import.meta.url), "utf8"));
  const settings = { SETTING_POLITO_USERNAME: "s123456", SETTING_POLITO_PASSWORD: "pa$$word", SETTING_TOKEN: "x".repeat(32) };
  const out = checkCompose(fillVars(compose, settings), { id: "polito", network: "grokdash", env: { DASH_URL: "http://dashboard:8787", DASH_TOKEN: "t" } });
  assert.deepEqual(Object.keys(out.services), ["polito-areadidattica", "polito-adapter"]);
  assert.ok(Object.values(out.services).every((s) => !s.volumes.some((v) => v.source.startsWith("/")) && s.ports === undefined));
  // Only the adapter hears from the dashboard, and both services share the one token.
  assert.equal(out.services["polito-adapter"].environment.DASH_TOKEN, "t");
  assert.equal(out.services["polito-areadidattica"].environment.DASH_TOKEN, undefined);
  assert.equal(out.services["polito-areadidattica"].environment.API_TOKEN, out.services["polito-adapter"].environment.AREADIDATTICA_TOKEN);
  assert.equal(out.services["polito-adapter"].environment.AREADIDATTICA_URL, "http://polito-areadidattica:8789");
  // Every setting the compose file names exists in the manifest.
  const manifest = JSON.parse(fs.readFileSync(new URL("../apps/polito/addon.json", import.meta.url), "utf8"));
  const keys = new Set(manifest.settings.map((s) => `SETTING_${s.key.toUpperCase()}`));
  for (const name of JSON.stringify(compose).matchAll(/\$\{(SETTING_[A-Z0-9_]+)\}/g)) assert.ok(keys.has(name[1]), name[1]);
});
