// Mail: reads up to three mailboxes over IMAP, read-only, and sends new mail and your replies to triage.
// It never sets flags, moves or deletes anything.

import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { settings, sendMessages, memory, status, every, log } from "../../sdk/dashboard.mjs";

export const SLOTS = [1, 2, 3];
/** The first time a mailbox is read, it looks back this far, so a big inbox doesn't flood triage. */
export const FIRST_LOOK_BACK_MS = 3 * 86_400_000;
// A longer backlog continues on the next run.
const MAX_PER_RUN = 200;
// The dashboard takes at most 500 messages per call.
const BATCH = 500;
const MAX_TEXT = 4000;

/** "imap.example.com" or "imap.example.com:143" as { host, port }, or null when it doesn't look like one. */
export function parseHost(raw) {
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(String(raw ?? "").trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 993;
  return port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
}

/** The mailbox in slot n from the settings: null when it's off, { error } when it's set up wrong. */
export function mailbox(n, s = settings) {
  const rawHost = String(s[`mail${n}Host`] ?? "").trim();
  if (!rawHost) return null;
  const user = String(s[`mail${n}User`] ?? "").trim();
  const password = String(s[`mail${n}Password`] ?? "");
  if (!user || !password) return { slot: n, error: "login or password missing" };
  const where = parseHost(rawHost);
  if (!where) return { slot: n, error: "the IMAP server must look like imap.example.com or imap.example.com:993" };
  return { slot: n, name: String(s[`mail${n}Name`] ?? "").trim() || `Mail ${n}`, host: where.host, port: where.port, user, password };
}

/** Text without quoted replies and signatures' long tails, so triage reads what's new. */
export function cleanText(text) {
  const lines = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    // "On Mon, 12 Oct 2026, Marco wrote:" and the Italian "Il giorno ... ha scritto:" start the quoted part.
    if (/^(on .{4,200} wrote:|il giorno .{4,200} ha scritto:|-----original message-----|-----messaggio originale-----)\s*$/i.test(line.trim())) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  const out = lines.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT - 1).trimEnd() + "…" : out;
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

const subjectOnly = (s) => s.replace(/^\s*((re|r|fwd?|i|inoltra)\s*:\s*)+/i, "").trim();
const ids = (s) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];

const headerOf = (parsed, name) => parsed.headers.find((h) => h.key === name)?.value ?? "";

/** Newsletters, bulk mail and no-reply senders, told apart by their headers. */
export function isAutomated(parsed) {
  const fromAddress = (parsed.from && "address" in parsed.from ? parsed.from.address : "") ?? "";
  const autoSubmitted = headerOf(parsed, "auto-submitted").toLowerCase();
  return (
    Boolean(headerOf(parsed, "list-unsubscribe") || headerOf(parsed, "list-id")) ||
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    /^(bulk|list|junk)$/i.test(headerOf(parsed, "precedence")) ||
    /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon)@/i.test(fromAddress)
  );
}

/** A thread is named after its first message, so replies (yours too) land in the same thread. */
export function threadOf(parsed, messageId) {
  return ids(headerOf(parsed, "references"))[0] ?? ids(parsed.inReplyTo)[0] ?? messageId;
}

export const sourceOf = (box) => `mail:${box.slot}`;
export const isGmail = (box) => box.host === "imap.gmail.com";

/** The source entry that describes a mailbox to the dashboard. */
export const describe = (box) => ({ id: sourceOf(box), name: box.name.slice(0, 40), app: isGmail(box) ? "gmail" : "mail", kind: "mail" });

// The dashboard refuses a whole batch for one field that's too long, which would hold the cursor back for good.
const cut = (s, max) => String(s ?? "").trim().slice(0, max);

/** Turn one parsed message into the fields POST /api/addon/messages takes. */
export function toMessage(box, parsed, uid, folder, fallbackDate) {
  const messageId = parsed.messageId || `<uid-${folder}-${uid}@${box.host}>`;
  const fromAddress = (parsed.from && "address" in parsed.from ? parsed.from.address : "") ?? "";
  const fromName = (parsed.from && "name" in parsed.from ? parsed.from.name : "") ?? "";
  const date = parsed.date ? Date.parse(parsed.date) : NaN;
  const body = parsed.text || (parsed.html ? htmlToText(parsed.html) : "");
  const link = isGmail(box) && parsed.messageId
    ? `https://mail.google.com/mail/u/0/#search/rfc822msgid%3A${encodeURIComponent(parsed.messageId.replace(/[<>]/g, ""))}`
    : "";
  return {
    source: sourceOf(box),
    extId: cut(`${folder}:${messageId}`, 300),
    thread: cut(threadOf(parsed, messageId), 300),
    threadName: cut(subjectOnly(parsed.subject ?? "") || "(no subject)", 200),
    sender: cut(folder === "sent" ? "You" : fromName || fromAddress, 200),
    fromMe: folder === "sent" || fromAddress.toLowerCase() === box.user.toLowerCase(),
    isGroup: false,
    automated: folder === "inbox" && isAutomated(parsed),
    subject: cut(parsed.subject ?? "", 300),
    text: cleanText(body),
    link: link.length <= 2000 ? link : "",
    at: Number.isFinite(date) && date > 0 ? date : fallbackDate,
  };
}

// Old servers like PoliTO's use Diffie-Hellman keys that OpenSSL now refuses by default.
// Those hosts get one retry with the older security level, remembered for the next runs.
const legacyHosts = new Set();
const isWeakDh = (err) => /dh key too small|dh_key_too_small/i.test(String(err?.message ?? err));

async function connect(box) {
  const open = async (legacy) => {
    const client = new ImapFlow({
      host: box.host,
      port: box.port,
      secure: true,
      auth: { user: box.user, pass: box.password },
      logger: false,
      socketTimeout: 60_000,
      tls: legacy ? { ciphers: "DEFAULT:@SECLEVEL=1" } : {},
    });
    // Errors after the connection is up arrive as events; without a listener they'd crash the add-on.
    client.on("error", () => {});
    await client.connect();
    return client;
  };
  if (legacyHosts.has(box.host)) return open(true);
  try {
    return await open(false);
  } catch (err) {
    if (!isWeakDh(err)) throw err;
    legacyHosts.add(box.host);
    return open(true);
  }
}

/**
 * Read one folder from the saved cursor, oldest first, at most MAX_PER_RUN messages.
 * Returns the messages and the cursor to save once the dashboard has accepted them.
 * `cursor` is { uidValidity, lastUid } or undefined on the first run.
 */
export async function readFolder(client, box, path, folder, cursor, now = Date.now()) {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const mb = client.mailbox;
    if (!mb) return { messages: [], cursor };
    const validity = String(mb.uidValidity);
    let uids;
    let lastUid;
    if (!cursor || cursor.uidValidity !== validity) {
      // First run, or the server renumbered the folder: start from a few days back.
      uids = (await client.search({ since: new Date(now - FIRST_LOOK_BACK_MS) }, { uid: true })) || [];
      // With nothing recent, everything up to now counts as read.
      lastUid = uids.length ? Math.min(...uids) - 1 : Math.max(0, Number(mb.uidNext ?? 1) - 1);
    } else {
      lastUid = cursor.lastUid;
      // "n:*" also returns the newest message when its UID is below n, so filter again.
      uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > lastUid);
    }
    const batch = uids.sort((x, y) => x - y).slice(0, MAX_PER_RUN);
    const messages = [];
    if (batch.length) {
      for await (const msg of client.fetch(batch, { uid: true, internalDate: true, source: { maxLength: 400_000 } }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await PostalMime.parse(msg.source);
        const internal = msg.internalDate ? new Date(msg.internalDate).getTime() : now;
        messages.push(toMessage(box, parsed, msg.uid, folder, internal));
      }
      lastUid = batch.at(-1);
    }
    return { messages, cursor: { uidValidity: validity, lastUid } };
  } finally {
    lock.release();
  }
}

/** Send messages to triage in calls of at most 500. Returns how many were new to the dashboard. */
export async function sendAll(box, messages, send = sendMessages) {
  let added = 0;
  for (let i = 0; i < messages.length; i += BATCH) {
    const res = await send([describe(box)], messages.slice(i, i + BATCH));
    added += Number(res?.added) || 0;
  }
  return added;
}

// One file with a cursor per folder. The key names the login and server, so changing them starts afresh.
const cursorKey = (box, path) => `${box.slot}:${box.user}@${box.host}:${path}`;

/** Read one folder, send what's new, and only then move its cursor. */
export async function syncFolder(client, box, path, folder, deps = {}) {
  const { load = (k) => memory.load("cursors", {})[k], save = saveCursor, send = sendMessages, now = Date.now() } = deps;
  const key = cursorKey(box, path);
  const read = await readFolder(client, box, path, folder, load(key), now);
  const added = await sendAll(box, read.messages, send);
  if (read.cursor) save(key, read.cursor);
  return added;
}

function saveCursor(key, cursor) {
  memory.save("cursors", { ...memory.load("cursors", {}), [key]: cursor });
}

/** Read the inbox and the Sent folder of one mailbox. Returns how many messages were new. */
async function readMailbox(box) {
  const client = await connect(box);
  try {
    let added = await syncFolder(client, box, "INBOX", "inbox");
    const sent = (await client.list()).find((b) => b.specialUse === "\\Sent");
    if (sent) added += await syncFolder(client, box, sent.path, "sent");
    return added;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** A short reason a mailbox failed. Never includes the password. */
export function explain(err, box) {
  if (err?.authenticationFailed) return "login failed, check the login and password";
  if (err?.code === "ENOTFOUND") return `can't find the server ${box.host}`;
  if (err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT") return `can't reach ${box.host}:${box.port}`;
  let msg = String(err?.responseText || err?.message || err);
  if (box.password) msg = msg.split(box.password).join("***");
  return msg.slice(0, 100);
}

const clock = (at = new Date()) => at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TZ });

/** The status line: one part per mailbox that is on. */
export const statusLine = (parts) => (parts.length ? parts.map((p) => p.text).join(", ") : "No mailbox is set up. Add an IMAP server in the settings.");

async function sync() {
  const parts = [];
  for (const n of SLOTS) {
    const box = mailbox(n);
    if (!box) continue;
    if (box.error) {
      parts.push({ ok: false, text: `Mail ${n}: ${box.error}` });
      continue;
    }
    // One mailbox failing must not hold back the others; it is tried again next time.
    try {
      const added = await readMailbox(box);
      if (added) log(`mail ${n}: ${added} new`);
      parts.push({ ok: true, text: `Mail ${n} read ${clock()}${added ? ` (${added} new)` : ""}` });
    } catch (err) {
      log(`mail ${n} failed:`, explain(err, box));
      parts.push({ ok: false, text: `Mail ${n}: ${explain(err, box)}` });
    }
  }
  await status(statusLine(parts), parts.every((p) => p.ok));
}

if (process.env.DASH_URL) every(Math.max(1, Number(settings.every) || 2) * 60_000, sync);
