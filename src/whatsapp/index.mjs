// WhatsApp: your chats go to triage. Two WAHA bridges (https://waha.devlike.pro) link to your numbers
// like WhatsApp Web, and this adapter reads them. It only reads: it never sends, marks read or
// changes a chat. Linking happens in the app's panel, where the QR code shows.

import { settings, sendMessages, panel, status, onAction, every, memory, localNow, log } from "../../sdk/dashboard.mjs";

const SESSION = "default";
const PAGE = 100;
/** Pages of one chat read per run. A chat with more waits for the next run. */
const MAX_PAGES = 10;
const MAX_TEXT = 4000;
/** The dashboard takes up to 500 messages per call. */
const SEND_BATCH = 500;
/** The first read goes this far back. */
export const FIRST_LOOK_BACK_MS = 3 * 86_400_000;
const BOOK_MS = 3_600_000;
/** The dashboard refuses panel images over 300,000 characters. */
const MAX_IMAGE = 290_000;

export class Waha {
  constructor(base, key, fetchImpl = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.key = key;
    this.fetch = fetchImpl;
    /** The address book, read at most once an hour. */
    this.book = null;
  }

  async call(method, path, body, raw = false) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: { "X-Api-Key": this.key, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404 && method === "GET" && path === `/api/sessions/${SESSION}`) return null;
    if (!res.ok) {
      // WAHA's error text isn't shown: it can echo chat ids and message text.
      await res.body?.cancel().catch(() => {});
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
    return this.call("GET", `/api/${SESSION}/auth/qr?format=image`, undefined, true);
  }

  /** Your address book: each contact's saved name, by phone number and by LID. */
  async contacts() {
    const names = new Map();
    for (let offset = 0; offset < 20_000; offset += 1000) {
      const page = await this.call("GET", `/api/contacts/all?session=${SESSION}&limit=1000&offset=${offset}`);
      for (const c of page) {
        const name = (c.name || c.pushname || "").trim();
        if (!name) continue;
        for (const id of [c.id, c.lid, c.phoneNumber]) {
          const digits = (id ?? "").replace(/@.*/, "");
          if (/^\d+$/.test(digits)) names.set(digits, name);
        }
      }
      if (page.length < 1000) break;
    }
    return names;
  }

  /** The address book changes rarely. If it can't be read, names fall back to numbers. */
  async addressBook(now) {
    if (this.book && now - this.book.at < BOOK_MS) return this.book.names;
    try {
      this.book = { at: now, names: await this.contacts() };
    } catch {
      return this.book?.names ?? new Map();
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
}

export const isGroup = (id) => id.endsWith("@g.us");
/** Status updates and broadcast lists aren't conversations. */
export const skipChat = (id) => id === "status@broadcast" || id.endsWith("@broadcast");

/** Mentions of you show as @<your LID or number>; they become @<your name>, so triage can tell a question is for you. */
export function mentionsOfYou(text, you) {
  const ids = [you.me, you.lid].filter((x) => x && /^\d+$/.test(x));
  if (!ids.length) return text;
  return text.replace(new RegExp(`@(${ids.join("|")})\\b`, "g"), `@${you.name || "you"}`);
}

/** Mentions of other people (@<number or LID>) become the names in your address book. */
export function mentionsOfOthers(text, names) {
  return text.replace(/@(\d{6,})\b/g, (all, id) => (names.has(id) ? `@${names.get(id)}` : all));
}

/** One WAHA message, as the message the dashboard's triage takes. */
export function toMessage(chat, m, source = "whatsapp:1", you, names = new Map()) {
  const group = isGroup(chat.id);
  const bare = (x) => (x ?? "").replace(/@.*/, "");
  const name = chat.name || names.get(bare(chat.id)) || bare(chat.id);
  // The name you saved for someone comes first, then the name they set for themselves, then their number.
  const who = m.fromMe
    ? "You"
    : m._data?.verifiedBizName || (group ? names.get(bare(m.participant)) : undefined) || m._data?.pushName || (group ? bare(m.participant) : name) || name;
  let text = (m.body ?? "").trim();
  if (you) text = mentionsOfYou(text, you);
  text = mentionsOfOthers(text, names);
  if (!text && m.hasMedia) text = "[media]";
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - 1).trimEnd() + "…";
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
    at: m.timestamp * 1000,
  };
}

/** The chats with something newer than `since` (seconds), from the list the pages gave. */
export function activeChats(pages, since) {
  const active = new Map();
  for (const page of pages) for (const c of page) if (!skipChat(c.id) && (c.lastMessage?.timestamp ?? 0) >= since) active.set(c.id, c);
  return active;
}

/**
 * Read new messages for one number. `saved` is what the last run left: { linked, me, cursor, resume }.
 * Returns { waiting: status } when the number isn't linked, else the messages and the `saved` to keep
 * once they reached the dashboard. Nothing is saved here, so a failed send reads the same messages again.
 */
export async function readNumber(waha, slot, saved = {}, now = Date.now()) {
  const session = await waha.ensureSession(Boolean(saved.linked));
  if (session.status !== "WORKING") return { waiting: session.status };
  const me = session.me || "yes";
  // A different account linked to this bridge starts fresh. Messages read twice are skipped as duplicates anyway.
  const same = saved.me === me;
  // WhatsApp timestamps are seconds.
  const cursor = same && saved.cursor ? saved.cursor : Math.floor((now - FIRST_LOOK_BACK_MS) / 1000);
  const resume = same ? (saved.resume ?? {}) : {};
  // Messages can reach WAHA late (a phone that was offline), so each run looks 10 minutes behind the cursor.
  const since = cursor - 600;
  const started = Math.floor(now / 1000);
  const pages = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await waha.chats(offset);
    pages.push(page);
    // Chats come newest first: once a page reaches back past the cursor, the rest are older still.
    if (page.length < PAGE || page.some((c) => (c.lastMessage?.timestamp ?? 0) < since)) break;
  }
  const active = activeChats(pages, since);
  // A chat cut short last time goes on from where it stopped, with the same starting point.
  for (const [id, r] of Object.entries(resume)) if (!active.has(id)) active.set(id, { id, name: r.name });
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

// ---------- The panel ----------

export const NEW_CODE = (slot) => `Show a new QR code (number ${slot})`;

const STEPS = "On your phone, open WhatsApp, then Settings, Linked devices, Link a device. Point the camera at the code below.";

/** How the panel and the status line describe numbers, from what each number's last read left. */
export function describe(numbers) {
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
      rows.push({ title: n.name, sub: "Getting a QR code from WhatsApp…", badge: `Number ${n.slot}` });
      parts.push(`${n.name}: getting a QR code`);
    } else if (n.state) {
      ok = false;
      blocks.push({ type: "text", text: `${label} isn't linked. The last QR code expired unscanned.` });
      blocks.push({ type: "buttons", items: [{ label: NEW_CODE(n.slot), instruction: `Show a new QR code for ${n.name}.` }] });
      parts.push(`${n.name}: not linked, ask for a new QR code in the panel`);
    } else {
      rows.push({ title: n.name, sub: "Connecting…", badge: `Number ${n.slot}` });
      parts.push(`${n.name}: connecting`);
    }
  }
  return { blocks: [...(rows.length ? [{ type: "list", items: rows }] : []), ...blocks], text: parts.join(". "), ok };
}

// ---------- Running ----------

const TICK_MS = 10_000;
const READ_MS = 60_000;
const WAITING = new Set(["SCAN_QR_CODE", "STARTING", "MISSING"]);

async function run() {
  const key = process.env.WAHA_API_KEY ?? "";
  const slots = [
    { slot: 1, url: process.env.WAHA1_URL, name: settings.number1Name?.trim() || "WhatsApp" },
    ...(settings.number2Name?.trim() ? [{ slot: 2, url: process.env.WAHA2_URL, name: settings.number2Name.trim() }] : []),
  ].filter((s) => s.url);
  const wahas = new Map(slots.map((s) => [s.slot, new Waha(s.url, key)]));
  const saved = memory.load("state", {});
  /** What each number looked like at its last read. */
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
      // Only after the dashboard has the messages does the position move.
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

  /**
   * Show the numbers' state, but only when it changed. The read time alone doesn't count (it moves
   * every minute), so it catches up when something else changes or after 15 minutes.
   */
  async function show() {
    const all = [...views.values()];
    const d = describe(all);
    const mark = JSON.stringify(describe(all.map((v) => ({ ...v, readAt: "" }))).blocks);
    if (mark !== lastPanel || Date.now() - lastPanelAt > 15 * 60_000) {
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
      // Check often while a code is up, so the panel knows as soon as you scan.
      // After a failure, wait a little longer each time, up to 15 minutes.
      const wait = v.failingSince ? Math.min(15 * 60_000, Math.max(READ_MS, (now - v.failingSince) / 2)) : WAITING.has(v.state) ? TICK_MS : READ_MS;
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
