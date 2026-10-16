// Built from src/whatsapp by build.mjs. Don't edit: change the source and run npm run build.
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
var panel = (title, blocks) => api("PUT", "/api/bot/panel", { title, blocks });
var status = (text, ok = true) => api("PUT", "/api/addon/status", { text: String(text).slice(0, 200), ok });
var sendMessages = (sources, messages) => api("POST", "/api/addon/messages", { sources, messages });
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
var log = (...args) => console.log((/* @__PURE__ */ new Date()).toISOString().slice(11, 19), ...args);
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
  void tick();
  return setInterval(tick, ms);
}
function onAction(handler, opts = {}) {
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
  return setInterval(tick, pollMs);
}
function localNow(at = /* @__PURE__ */ new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value])
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// src/whatsapp/index.mjs
var SESSION = "default";
var PAGE = 100;
var MAX_PAGES = 10;
var MAX_TEXT = 4e3;
var SEND_BATCH = 500;
var FIRST_LOOK_BACK_MS = 3 * 864e5;
var BOOK_MS = 36e5;
var MAX_IMAGE = 29e4;
var Waha = class {
  constructor(base, key, fetchImpl = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
    this.fetch = fetchImpl;
    this.book = null;
  }
  async call(method, path2, body, raw = false) {
    const res = await this.fetch(this.base + path2, {
      method,
      headers: { "X-Api-Key": this.key, ...body === void 0 ? {} : { "Content-Type": "application/json" } },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(3e4)
    });
    if (res.status === 404 && method === "GET" && path2 === `/api/sessions/${SESSION}`) return null;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {
      });
      throw new Error(`WAHA answered ${res.status}.${res.status === 401 ? " Check the API key." : ""}`);
    }
    if (raw) return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "" };
    return res.status === 204 ? null : res.json();
  }
  /** WAHA's session status (STOPPED, STARTING, SCAN_QR_CODE, WORKING, FAILED, or MISSING before the session exists) and who is linked. */
  async status() {
    const s = await this.call("GET", `/api/sessions/${SESSION}`);
    if (!s) return { status: "MISSING", me: "" };
    return { status: s.status, me: (s.me?.id ?? "").replace(/@.*/, ""), lid: (s.me?.lid ?? "").replace(/@.*/, ""), name: s.me?.pushName ?? "" };
  }
  /**
   * Create the session if it's missing. A stopped or failed session restarts only when it was linked
   * before (a dropped connection). An unlinked one stopped because nobody scanned its code in time,
   * and it waits for a press on "Show a new QR code" instead of making codes nobody looks at.
   */
  async ensureSession(wasLinked) {
    const now = await this.status();
    if (now.status === "MISSING") return this.link();
    if ((now.status === "STOPPED" || now.status === "FAILED") && wasLinked) {
      await this.call("POST", `/api/sessions/${SESSION}/restart`);
      return this.status();
    }
    return now;
  }
  /** Start linking: create the session, or restart it so WhatsApp shows a fresh code. markOnline stays off, so the phone keeps its notifications. */
  async link() {
    const config = { noweb: { markOnline: false, store: { enabled: true, fullSync: false } } };
    const now = await this.status();
    if (now.status === "MISSING") await this.call("POST", "/api/sessions", { name: SESSION, start: true, config });
    else await this.call("POST", `/api/sessions/${SESSION}/restart`);
    return this.status();
  }
  /** The QR code to link the account, as an image. */
  async qr() {
    return this.call("GET", `/api/${SESSION}/auth/qr?format=image`, void 0, true);
  }
  /** Your address book: each contact's saved name, by phone number and by LID. */
  async contacts() {
    const names = /* @__PURE__ */ new Map();
    for (let offset = 0; offset < 2e4; offset += 1e3) {
      const page = await this.call("GET", `/api/contacts/all?session=${SESSION}&limit=1000&offset=${offset}`);
      for (const c of page) {
        const name = (c.name || c.pushname || "").trim();
        if (!name) continue;
        for (const id2 of [c.id, c.lid, c.phoneNumber]) {
          const digits = (id2 ?? "").replace(/@.*/, "");
          if (/^\d+$/.test(digits)) names.set(digits, name);
        }
      }
      if (page.length < 1e3) break;
    }
    return names;
  }
  /** The address book changes rarely. If it can't be read, names fall back to numbers. */
  async addressBook(now) {
    if (this.book && now - this.book.at < BOOK_MS) return this.book.names;
    try {
      this.book = { at: now, names: await this.contacts() };
    } catch {
      return this.book?.names ?? /* @__PURE__ */ new Map();
    }
    return this.book.names;
  }
  /** One page of chats, the most recently active first. */
  chats(offset) {
    return this.call("GET", `/api/${SESSION}/chats/overview?limit=${PAGE}&offset=${offset}`);
  }
  /** One page of a chat's messages since a time, oldest first. */
  messagesSince(chatId, since, offset) {
    const q = `limit=${PAGE}&offset=${offset}&sortBy=timestamp&sortOrder=asc&downloadMedia=false&filter.timestamp.gte=${since}`;
    return this.call("GET", `/api/${SESSION}/chats/${encodeURIComponent(chatId)}/messages?${q}`);
  }
};
var isGroup = (id2) => id2.endsWith("@g.us");
var skipChat = (id2) => id2 === "status@broadcast" || id2.endsWith("@broadcast");
function mentionsOfYou(text, you) {
  const ids = [you.me, you.lid].filter((x) => x && /^\d+$/.test(x));
  if (!ids.length) return text;
  return text.replace(new RegExp(`@(${ids.join("|")})\\b`, "g"), `@${you.name || "you"}`);
}
function mentionsOfOthers(text, names) {
  return text.replace(/@(\d{6,})\b/g, (all, id2) => names.has(id2) ? `@${names.get(id2)}` : all);
}
function toMessage(chat, m, source = "whatsapp:1", you, names = /* @__PURE__ */ new Map()) {
  const group = isGroup(chat.id);
  const bare = (x) => (x ?? "").replace(/@.*/, "");
  const name = chat.name || names.get(bare(chat.id)) || bare(chat.id);
  const who = m.fromMe ? "You" : m._data?.verifiedBizName || (group ? names.get(bare(m.participant)) : void 0) || m._data?.pushName || (group ? bare(m.participant) : name) || name;
  let text = (m.body ?? "").trim();
  if (you) text = mentionsOfYou(text, you);
  text = mentionsOfOthers(text, names);
  if (!text && m.hasMedia) text = "[media]";
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1).trimEnd() + "\u2026";
  return {
    source,
    extId: String(m.id).slice(0, 300),
    thread: chat.id.slice(0, 300),
    threadName: name.slice(0, 200),
    sender: who.slice(0, 200),
    fromMe: Boolean(m.fromMe),
    isGroup: group,
    // Channels (newsletters) and verified businesses are broadcasts, not people.
    automated: chat.id.endsWith("@newsletter") || Boolean(m._data?.verifiedBizName),
    subject: "",
    text,
    link: "",
    at: m.timestamp * 1e3
  };
}
function activeChats(pages, since) {
  const active = /* @__PURE__ */ new Map();
  for (const page of pages) for (const c of page) if (!skipChat(c.id) && (c.lastMessage?.timestamp ?? 0) >= since) active.set(c.id, c);
  return active;
}
async function readNumber(waha, slot, saved = {}, now = Date.now()) {
  const session = await waha.ensureSession(Boolean(saved.linked));
  if (session.status !== "WORKING") return { waiting: session.status };
  const me = session.me || "yes";
  const same = saved.me === me;
  const cursor = same && saved.cursor ? saved.cursor : Math.floor((now - FIRST_LOOK_BACK_MS) / 1e3);
  const resume = same ? saved.resume ?? {} : {};
  const since = cursor - 600;
  const started = Math.floor(now / 1e3);
  const pages = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await waha.chats(offset);
    pages.push(page);
    if (page.length < PAGE || page.some((c) => (c.lastMessage?.timestamp ?? 0) < since)) break;
  }
  const active = activeChats(pages, since);
  for (const [id2, r] of Object.entries(resume)) if (!active.has(id2)) active.set(id2, { id: id2, name: r.name });
  const names = await waha.addressBook(now);
  const source = `whatsapp:${slot}`;
  const found = [];
  const next = {};
  for (const chat of active.values()) {
    const from = resume[chat.id]?.since ?? since;
    let offset = resume[chat.id]?.offset ?? 0;
    for (let p = 0; ; p++, offset += PAGE) {
      const page = await waha.messagesSince(chat.id, from, offset);
      for (const m of page) if (m.id && m.timestamp) found.push(toMessage(chat, m, source, session, names));
      if (page.length < PAGE) break;
      if (p + 1 >= MAX_PAGES) {
        next[chat.id] = { name: chat.name ?? "", since: from, offset: offset + PAGE };
        break;
      }
    }
  }
  return { me, messages: found, saved: { linked: me, me, cursor: Math.max(cursor, started), resume: next } };
}
var NEW_CODE = (slot) => `Show a new QR code (number ${slot})`;
var STEPS = "On your phone, open WhatsApp, then Settings, Linked devices, Link a device. Point the camera at the code below.";
function describe(numbers) {
  const rows = [];
  const blocks = [];
  const parts = [];
  let ok = true;
  for (const n of numbers) {
    const label = `${n.name} (number ${n.slot})`;
    if (n.error) {
      ok = false;
      rows.push({ title: n.name, sub: n.error.slice(0, 200), badge: `Number ${n.slot}` });
      parts.push(`${n.name}: ${n.error}`);
    } else if (n.state === "linked") {
      rows.push({ title: n.name, sub: `${n.me && /^\d+$/.test(n.me) ? `Linked to +${n.me}` : "Linked"}, read ${n.readAt}`, badge: `Number ${n.slot}` });
      parts.push(`${n.name}: read ${n.readAt}`);
    } else if (n.state === "SCAN_QR_CODE") {
      ok = false;
      blocks.push({ type: "text", text: `${label} isn't linked yet. ${STEPS}` });
      if (n.qr) blocks.push({ type: "image", src: n.qr, alt: `QR code to link ${n.name}` });
      parts.push(`${n.name}: scan the QR code in the panel`);
    } else if (n.state === "STARTING" || n.state === "MISSING") {
      rows.push({ title: n.name, sub: "Getting a QR code from WhatsApp\u2026", badge: `Number ${n.slot}` });
      parts.push(`${n.name}: getting a QR code`);
    } else if (n.state) {
      ok = false;
      blocks.push({ type: "text", text: `${label} isn't linked. The last QR code expired unscanned.` });
      blocks.push({ type: "buttons", items: [{ label: NEW_CODE(n.slot), instruction: `Show a new QR code for ${n.name}.` }] });
      parts.push(`${n.name}: not linked, ask for a new QR code in the panel`);
    } else {
      rows.push({ title: n.name, sub: "Connecting\u2026", badge: `Number ${n.slot}` });
      parts.push(`${n.name}: connecting`);
    }
  }
  return { blocks: [...rows.length ? [{ type: "list", items: rows }] : [], ...blocks], text: parts.join(". "), ok };
}
var TICK_MS = 1e4;
var READ_MS = 6e4;
var WAITING = /* @__PURE__ */ new Set(["SCAN_QR_CODE", "STARTING", "MISSING"]);
async function run() {
  const key = process.env.WAHA_API_KEY ?? "";
  const slots = [
    { slot: 1, url: process.env.WAHA1_URL, name: settings.number1Name?.trim() || "WhatsApp" },
    ...settings.number2Name?.trim() ? [{ slot: 2, url: process.env.WAHA2_URL, name: settings.number2Name.trim() }] : []
  ].filter((s) => s.url);
  const wahas = new Map(slots.map((s) => [s.slot, new Waha(s.url, key)]));
  const saved = memory.load("state", {});
  const views = new Map(slots.map((s) => [s.slot, { slot: s.slot, name: s.name, state: "", me: "", readAt: "", error: "", qr: "", lastRun: 0, failingSince: 0 }]));
  let lastPanel = "";
  let lastPanelAt = 0;
  let lastStatus = "";
  async function readOne(s) {
    const v = views.get(s.slot);
    v.lastRun = Date.now();
    try {
      const r = await readNumber(wahas.get(s.slot), s.slot, saved[s.slot], Date.now());
      v.error = "";
      v.failingSince = 0;
      if ("waiting" in r) {
        v.state = r.waiting;
        v.qr = r.waiting === "SCAN_QR_CODE" ? await qrImage(wahas.get(s.slot)) : "";
        return;
      }
      for (let i = 0; i < r.messages.length; i += SEND_BATCH) {
        await sendMessages([{ id: `whatsapp:${s.slot}`, name: s.name, app: "whatsapp", kind: "chat" }], r.messages.slice(i, i + SEND_BATCH));
      }
      saved[s.slot] = r.saved;
      memory.save("state", saved);
      Object.assign(v, { state: "linked", me: r.me, readAt: localNow().time, qr: "" });
      if (r.messages.length) log(`number ${s.slot}: ${r.messages.length} messages`);
    } catch (err) {
      v.error = err.message;
      v.failingSince ||= Date.now();
    }
  }
  async function qrImage(waha) {
    try {
      const { data, type } = await waha.qr();
      const mime = /jpe?g/i.test(type) ? "image/jpeg" : "image/png";
      const src = `data:${mime};base64,${data.toString("base64")}`;
      return src.length <= MAX_IMAGE ? src : "";
    } catch {
      return "";
    }
  }
  async function show() {
    const all = [...views.values()];
    const d = describe(all);
    const mark = JSON.stringify(describe(all.map((v) => ({ ...v, readAt: "" }))).blocks);
    if (mark !== lastPanel || Date.now() - lastPanelAt > 15 * 6e4) {
      await panel("WhatsApp", d.blocks);
      lastPanel = mark;
      lastPanelAt = Date.now();
    }
    if (d.text !== lastStatus) {
      await status(d.text, d.ok);
      lastStatus = d.text;
    }
  }
  async function tick() {
    const now = Date.now();
    for (const s of slots) {
      const v = views.get(s.slot);
      const wait = v.failingSince ? Math.min(15 * 6e4, Math.max(READ_MS, (now - v.failingSince) / 2)) : WAITING.has(v.state) ? TICK_MS : READ_MS;
      if (now - v.lastRun >= wait) await readOne(s);
    }
    await show();
  }
  every(TICK_MS, tick);
  onAction(async (a) => {
    if (a.type !== "panel") return { ok: false, result: "WhatsApp only answers its panel." };
    const s = slots.find((x) => NEW_CODE(x.slot) === a.label);
    if (!s) return { ok: false, result: "That button is gone." };
    await wahas.get(s.slot).link();
    await readOne(s);
    await show();
    return { ok: true, result: "Asked WhatsApp for a new QR code" };
  });
}
if (process.env.DASH_URL) await run();
export {
  FIRST_LOOK_BACK_MS,
  NEW_CODE,
  Waha,
  activeChats,
  describe,
  isGroup,
  mentionsOfOthers,
  mentionsOfYou,
  readNumber,
  skipChat,
  toMessage
};
