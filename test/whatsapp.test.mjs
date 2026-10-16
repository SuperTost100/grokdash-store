import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Waha, readNumber, toMessage, mentionsOfYou, mentionsOfOthers, activeChats, describe, NEW_CODE } from "../src/whatsapp/index.mjs";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NOW_S = Math.floor(Date.parse("2026-10-12T11:00:00Z") / 1000);
const NOW = NOW_S * 1000;

/** A WAHA that answers from memory. `status` and `messages` can change between calls. */
function fakeWaha() {
  const calls = [];
  const f = { status: "MISSING", calls };
  const now = NOW_S;
  const messages = {
    "120363@g.us": [
      { id: "g1", timestamp: now - 60, fromMe: false, participant: "39340@c.us", body: "Who's free on Tuesday?", _data: { pushName: "Marco" } },
      { id: "g2", timestamp: now - 30, fromMe: true, body: "Me" },
    ],
    "39333@c.us": [{ id: "d1", timestamp: now - 10, fromMe: false, body: "", hasMedia: true, _data: { pushName: "Anna" } }],
    "status@broadcast": [{ id: "s1", timestamp: now, fromMe: false, body: "story" }],
  };
  const fetchImpl = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal(new Headers(init?.headers).get("x-api-key"), "wkey");
    if (u.pathname === "/api/sessions/default") return f.status === "MISSING" ? json({ error: "not found" }, 404) : json({ status: f.status, me: f.status === "WORKING" ? { id: "39340000@c.us" } : null });
    if (u.pathname === "/api/sessions" && method === "POST") { f.status = "SCAN_QR_CODE"; return json({ status: f.status }); }
    if (u.pathname === "/api/sessions/default/restart" && method === "POST") { f.status = "SCAN_QR_CODE"; return json({ status: f.status }); }
    if (u.pathname === "/api/contacts/all") return json([]);
    if (u.pathname === "/api/default/chats/overview") {
      return json([
        { id: "120363@g.us", name: "Lab group", lastMessage: { timestamp: now - 30 } },
        { id: "39333@c.us", name: "Anna", lastMessage: { timestamp: now - 10 } },
        { id: "status@broadcast", name: null, lastMessage: { timestamp: now } },
        { id: "39999@c.us", name: "Old chat", lastMessage: { timestamp: now - 30 * 86400 } },
      ]);
    }
    const m = /^\/api\/default\/chats\/([^/]+)\/messages$/.exec(u.pathname);
    if (m) {
      const since = Number(u.searchParams.get("filter.timestamp.gte"));
      return json((messages[decodeURIComponent(m[1])] ?? []).filter((x) => x.timestamp >= since));
    }
    return json({ error: "unexpected" }, 500);
  };
  f.waha = new Waha("http://waha:3000/", "wkey", fetchImpl);
  return f;
}

test("an unlinked number gets a session with markOnline off and reads nothing", async () => {
  const f = fakeWaha();
  assert.deepEqual(await readNumber(f.waha, 1, {}, NOW), { waiting: "SCAN_QR_CODE" });
  const created = f.calls.find((c) => c.path === "/api/sessions");
  assert.deepEqual(created.body, { name: "default", start: true, config: { noweb: { markOnline: false, store: { enabled: true, fullSync: false } } } });
  assert.ok(!f.calls.some((c) => c.path.includes("/chats")));
});

test("a linked number reads new messages once, skipping status updates", async () => {
  const f = fakeWaha();
  f.status = "WORKING";
  const first = await readNumber(f.waha, 2, {}, NOW);
  assert.deepEqual(first.messages.map((r) => [r.source, r.thread, r.threadName, r.sender, r.fromMe, r.isGroup, r.text]), [
    ["whatsapp:2", "120363@g.us", "Lab group", "Marco", false, true, "Who's free on Tuesday?"],
    ["whatsapp:2", "120363@g.us", "Lab group", "You", true, true, "Me"],
    ["whatsapp:2", "39333@c.us", "Anna", "Anna", false, false, "[media]"],
  ]);
  assert.ok(!f.calls.some((c) => c.path.includes("39999")), "a chat with nothing new isn't opened");
  assert.equal(first.saved.linked, "39340000");
  assert.equal(first.saved.cursor, NOW_S);
  // The next run starts from the saved position. Ten minutes of overlap show the same messages, which the dashboard skips.
  const again = await readNumber(f.waha, 2, first.saved, NOW + 60_000);
  assert.equal(again.saved.cursor, NOW_S + 60);
  assert.ok(!f.calls.some((c) => c.method !== "GET" && c.path.includes("/chats")), "nothing is ever marked read or sent");
});

test("the saved position only moves when the caller saves it", async () => {
  const f = fakeWaha();
  f.status = "WORKING";
  const a = await readNumber(f.waha, 1, {}, NOW);
  const b = await readNumber(f.waha, 1, {}, NOW);
  assert.equal(a.messages.length, 3);
  assert.equal(b.messages.length, 3, "a failed send reads the same messages again");
});

test("a different account on the same bridge starts from the first look back", async () => {
  const f = fakeWaha();
  f.status = "WORKING";
  const r = await readNumber(f.waha, 1, { linked: "111", me: "111", cursor: NOW_S + 5000, resume: { "x@g.us": { name: "X", since: 1, offset: 100 } } }, NOW);
  assert.equal(r.messages.length, 3);
  assert.deepEqual(r.saved.resume, {});
});

test("a code that expired unscanned waits for a press; a linked number that drops reconnects", async () => {
  const f = fakeWaha();
  f.status = "FAILED";
  assert.deepEqual(await readNumber(f.waha, 1, {}, NOW), { waiting: "FAILED" });
  assert.ok(!f.calls.some((c) => c.path.endsWith("/restart")), "no new codes nobody looks at");
  f.status = "WORKING";
  const linked = await readNumber(f.waha, 1, {}, NOW);
  f.status = "FAILED";
  await readNumber(f.waha, 1, linked.saved, NOW);
  assert.ok(f.calls.some((c) => c.path === "/api/sessions/default/restart"), "a number that was linked reconnects by itself");
});

test("link restarts an existing session for a fresh code", async () => {
  const f = fakeWaha();
  f.status = "FAILED";
  assert.equal((await f.waha.link()).status, "SCAN_QR_CODE");
  assert.ok(f.calls.some((c) => c.path === "/api/sessions/default/restart"));
});

test("the QR code comes back as an image with its type", async () => {
  const png = Buffer.from([137, 80, 78, 71]);
  const waha = new Waha("http://waha:3000", "k", async () => new Response(png, { headers: { "content-type": "image/png" } }));
  const { data, type } = await waha.qr();
  assert.equal(type, "image/png");
  assert.deepEqual([...data], [...png]);
});

test("a WAHA error doesn't echo its answer, and a wrong key says so", async () => {
  const waha = new Waha("http://waha:3000", "k", async () => json({ error: "chat 39333@c.us says secret" }, 401));
  await assert.rejects(waha.status(), (e) => e.message === "WAHA answered 401. Check the API key.");
});

test("long chats are paged, and the position waits for a chat cut short", async () => {
  const big = Array.from({ length: 1150 }, (_, i) => ({ id: `b${i}`, timestamp: NOW_S - 3000 + i, fromMe: false, body: `m${i}` }));
  const fetchImpl = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/sessions/default") return json({ status: "WORKING", me: { id: "1@c.us" } });
    if (u.pathname === "/api/contacts/all") return json([]);
    if (u.pathname === "/api/default/chats/overview") {
      const off = Number(u.searchParams.get("offset"));
      // 150 chats: 149 quiet ones after the busy one, so the list needs two pages.
      const chats = [{ id: "big@g.us", name: "Busy", lastMessage: { timestamp: NOW_S } }, ...Array.from({ length: 149 }, (_, i) => ({ id: `q${i}@c.us`, name: `Q${i}`, lastMessage: { timestamp: NOW_S - 5 } }))];
      return json(chats.slice(off, off + 100));
    }
    if (u.pathname.includes("/messages")) {
      const off = Number(u.searchParams.get("offset"));
      const since = Number(u.searchParams.get("filter.timestamp.gte"));
      const list = u.pathname.includes("big") ? big.filter((m) => m.timestamp >= since) : [];
      return json(list.slice(off, off + 100));
    }
    return json({}, 500);
  };
  const waha = new Waha("http://waha:3000", "k", fetchImpl);
  const one = await readNumber(waha, 1, {}, NOW);
  assert.equal(one.messages.length, 1000, "10 pages per run");
  assert.match(JSON.stringify(one.saved.resume), /big@g\.us/, "the busy chat is marked to go on");
  const two = await readNumber(waha, 1, one.saved, NOW);
  assert.equal(two.messages.length, 150, "the next run gets the rest");
  assert.deepEqual(two.saved.resume, {});
});

test("1,500 messages within five minutes all arrive over two runs", async () => {
  const dense = Array.from({ length: 1500 }, (_, i) => ({ id: `d${i}`, timestamp: NOW_S - 300 + Math.floor(i / 5), fromMe: false, body: `m${i}` }));
  const fetchImpl = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/sessions/default") return json({ status: "WORKING", me: { id: "1@c.us" } });
    if (u.pathname === "/api/contacts/all") return json([]);
    if (u.pathname === "/api/default/chats/overview") return json(Number(u.searchParams.get("offset")) ? [] : [{ id: "dense@g.us", name: "Dense", lastMessage: { timestamp: NOW_S } }]);
    const off = Number(u.searchParams.get("offset"));
    const since = Number(u.searchParams.get("filter.timestamp.gte"));
    return json(dense.filter((m) => m.timestamp >= since).slice(off, off + 100));
  };
  const waha = new Waha("http://waha:3000", "k", fetchImpl);
  const first = await readNumber(waha, 1, {}, NOW);
  const second = await readNumber(waha, 1, first.saved, NOW + 60_000);
  const ids = new Set([...first.messages, ...second.messages].map((m) => m.extId));
  assert.equal(ids.size, 1500);
});

test("mentions of you become your name, so triage can tell a question is for you", () => {
  const you = { me: "393331112222", lid: "188411675705560", name: "Tost" };
  assert.equal(mentionsOfYou("@188411675705560 chiamiamo noi ora?", you), "@Tost chiamiamo noi ora?");
  assert.equal(mentionsOfYou("ciao @393331112222 e @555", you), "ciao @Tost e @555");
  assert.equal(mentionsOfYou("@1884116757055601 not you", you), "@1884116757055601 not you");
});

test("group senders and mentions use the names in your address book", () => {
  const names = new Map([["393401234567", "Marco Rossi"], ["188411675705999", "Anna"]]);
  const chat = { id: "120363@g.us", name: "Lab group" };
  const row = toMessage(chat, { id: "x", timestamp: 1, fromMe: false, participant: "393401234567@c.us", body: "@188411675705999 ci sei?" }, "whatsapp:1", undefined, names);
  assert.deepEqual([row.sender, row.text], ["Marco Rossi", "@Anna ci sei?"]);
  const byLid = toMessage(chat, { id: "y", timestamp: 1, fromMe: false, participant: "188411675705999@lid", body: "si", _data: { pushName: "anna_b" } }, "whatsapp:1", undefined, names);
  assert.equal(byLid.sender, "Anna", "your saved name beats the name they set");
  const unknown = toMessage(chat, { id: "z", timestamp: 1, fromMe: false, participant: "555000111@lid", body: "hey", _data: { pushName: "Gio" } }, "whatsapp:1", undefined, names);
  assert.equal(unknown.sender, "Gio");
  assert.equal(mentionsOfOthers("@555000111 e @393401234567", names), "@555000111 e @Marco Rossi");
});

test("a message maps to the fields the dashboard takes", () => {
  const long = "x".repeat(5000);
  const row = toMessage({ id: "1203@newsletter", name: "News" }, { id: "n1", timestamp: 1_700_000_000, fromMe: false, body: long }, "whatsapp:2");
  assert.deepEqual(Object.keys(row).sort(), ["at", "automated", "extId", "fromMe", "isGroup", "link", "sender", "source", "subject", "text", "thread", "threadName"]);
  assert.equal(row.at, 1_700_000_000_000);
  assert.equal(row.automated, true, "channels are broadcasts");
  assert.equal(row.text.length, 4000);
  const biz = toMessage({ id: "39@c.us", name: "Shop" }, { id: "n2", timestamp: 1, fromMe: false, body: "Offer", _data: { verifiedBizName: "Shop SRL" } });
  assert.deepEqual([biz.sender, biz.automated], ["Shop SRL", true]);
  const own = toMessage({ id: "39@c.us", name: "Anna" }, { id: "n3", timestamp: 1, fromMe: true, body: "ok" });
  assert.deepEqual([own.sender, own.fromMe, own.automated], ["You", true, false]);
});

test("chats with nothing newer than the cursor, and broadcast lists, are filtered out", () => {
  const pages = [[
    { id: "a@c.us", lastMessage: { timestamp: 100 } },
    { id: "status@broadcast", lastMessage: { timestamp: 200 } },
    { id: "list@broadcast", lastMessage: { timestamp: 200 } },
    { id: "b@c.us", lastMessage: { timestamp: 5 } },
    { id: "c@c.us" },
  ]];
  assert.deepEqual([...activeChats(pages, 50).keys()], ["a@c.us"]);
});

test("the address book is read once an hour, and a failure falls back to numbers", async () => {
  let reads = 0;
  let fail = false;
  const waha = new Waha("http://waha:3000", "k", async () => {
    reads++;
    return fail ? json({}, 500) : json([{ id: "39333@c.us", name: "Zia Carla", lid: "77777777@lid" }]);
  });
  const book = await waha.addressBook(NOW);
  assert.equal(book.get("77777777"), "Zia Carla");
  await waha.addressBook(NOW + 60_000);
  assert.equal(reads, 1, "cached for an hour");
  fail = true;
  assert.equal((await waha.addressBook(NOW + 7_200_000)).get("77777777"), "Zia Carla", "keeps the old book when the new read fails");
  const fresh = new Waha("http://waha:3000", "k", async () => json({}, 500));
  assert.equal((await fresh.addressBook(NOW)).size, 0, "no address book: numbers");
});

test("the panel shows a QR code to scan, a button when it expired, and who is linked", () => {
  const png = "data:image/png;base64,AAAA";
  const d = describe([
    { slot: 1, name: "WhatsApp", state: "linked", me: "393331112222", readAt: "14:05", error: "", qr: "" },
    { slot: 2, name: "Business", state: "SCAN_QR_CODE", me: "", readAt: "", error: "", qr: png },
  ]);
  assert.deepEqual(d.blocks[0].items.map((i) => [i.title, i.sub]), [["WhatsApp", "Linked to +393331112222, read 14:05"]]);
  assert.match(d.blocks[1].text, /Business \(number 2\) isn't linked yet. On your phone/);
  assert.deepEqual(d.blocks[2], { type: "image", src: png, alt: "QR code to link Business" });
  assert.equal(d.ok, false);
  assert.equal(d.text, "WhatsApp: read 14:05. Business: scan the QR code in the panel");

  const expired = describe([{ slot: 2, name: "Business", state: "FAILED", me: "", readAt: "", error: "", qr: "" }]);
  const buttons = expired.blocks.find((b) => b.type === "buttons");
  assert.equal(buttons.items[0].label, NEW_CODE(2));
  assert.equal(NEW_CODE(2), "Show a new QR code (number 2)");

  const failing = describe([{ slot: 1, name: "WhatsApp", state: "linked", me: "1", readAt: "14:05", error: "WAHA answered 500.", qr: "" }]);
  assert.equal(failing.ok, false);
  assert.match(failing.blocks[0].items[0].sub, /WAHA answered 500/);
  for (const b of [...d.blocks, ...expired.blocks]) assert.ok(["text", "list", "image", "buttons"].includes(b.type));
});

// ---------- The app's files ----------

const manifest = JSON.parse(fs.readFileSync(new URL("../apps/whatsapp/addon.json", import.meta.url), "utf8"));
const compose = JSON.parse(fs.readFileSync(new URL("../apps/whatsapp/compose.json", import.meta.url), "utf8"));
const RUNNER = "/home/tost/.t3/worktrees/Grog-Bot-Dashboard/t3-5dfa18aa/runner/validate.mjs";

test("compose.json follows the runner's rules", async (t) => {
  if (!fs.existsSync(RUNNER)) return t.skip("the dashboard's runner isn't on this machine");
  const { checkCompose } = await import(RUNNER);
  const out = checkCompose(compose, { id: "whatsapp", network: "grokdash", env: { DASH_URL: "http://dash", DASH_TOKEN: "t" } });
  assert.deepEqual(Object.keys(out.services).sort(), ["whatsapp-adapter", "whatsapp-waha1", "whatsapp-waha2"]);
  assert.equal(out.services["whatsapp-adapter"].environment.DASH_TOKEN, "t");
  assert.equal(out.services["whatsapp-waha1"].environment.DASH_TOKEN, undefined, "WAHA never sees the dashboard's token");
  assert.ok(Object.values(out.services).every((s) => !s.ports));
});

test("the manifest and compose agree", () => {
  assert.deepEqual([manifest.id, manifest.type, manifest.compose, manifest.memory, manifest.color, manifest.asks], ["whatsapp", "app", "compose.json", "700 MB", "#25d366", ["triage"]]);
  assert.deepEqual(manifest.settings.map((s) => s.key), ["apiKey", "number1Name", "number2Name"]);
  assert.equal(manifest.settings[0].type, "secret");
  assert.equal(manifest.settings[0].required, true);
  assert.equal(manifest.settings[1].default, "WhatsApp");
  assert.equal(manifest.settings[2].default, "");
  assert.equal(compose.services["whatsapp-adapter"]["x-dashboard"], true);
  assert.equal(compose.services["whatsapp-adapter"].environment.WAHA_API_KEY, "${SETTING_APIKEY}");
  for (const n of [1, 2]) assert.equal(compose.services[`whatsapp-waha${n}`].environment.WAHA_API_KEY, "${SETTING_APIKEY}");
  // Every named volume a service mounts is declared.
  for (const svc of Object.values(compose.services)) for (const v of svc.volumes ?? []) assert.ok(v.split(":")[0] in compose.volumes);
});
