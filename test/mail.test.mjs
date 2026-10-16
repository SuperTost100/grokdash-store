import test from "node:test";
import assert from "node:assert/strict";
import PostalMime from "postal-mime";
import {
  cleanText, parseHost, mailbox, toMessage, isAutomated, describe, readFolder, sendAll, syncFolder, explain, statusLine, FIRST_LOOK_BACK_MS,
} from "../src/mail/index.mjs";

const box = { slot: 2, name: "Gmail", host: "imap.gmail.com", port: 993, user: "me@gmail.com", password: "secret-pw" };
const mail = (headers, body) => PostalMime.parse(`${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`);

test("a reply joins the thread of the first message and quoted text is dropped", async () => {
  const parsed = await mail(
    "From: Marco Rossi <marco@example.com>\r\nSubject: Re: Lab swap\r\nMessage-ID: <b@x>\r\nIn-Reply-To: <a@x>\r\nReferences: <a@x>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0200",
    "Tuesday works for me.\r\n\r\nOn Mon, 12 Oct 2026 at 09:00, Tost wrote:\r\n> Can we swap?\r\n> Thanks",
  );
  const row = toMessage(box, parsed, 7, "inbox", 0);
  assert.equal(row.thread, "<a@x>");
  assert.equal(row.threadName, "Lab swap");
  assert.equal(row.sender, "Marco Rossi");
  assert.equal(row.text, "Tuesday works for me.");
  assert.equal(row.extId, "inbox:<b@x>");
  assert.equal(row.fromMe, false);
  assert.equal(row.automated, false);
  assert.equal(row.source, "mail:2");
  assert.equal(row.at, Date.parse("2026-10-12T08:00:00Z"));
  assert.match(row.link, /^https:\/\/mail\.google\.com\/.*rfc822msgid%3Ab%40x$/);
});

test("newsletters and no-reply senders are automated; your sent mail is yours", async () => {
  const news = await mail("From: Shop <news@shop.example>\r\nSubject: Sale\r\nList-Unsubscribe: <mailto:u@shop.example>\r\nMessage-ID: <n@x>", "50% off");
  assert.equal(toMessage(box, news, 1, "inbox", 0).automated, true);
  const bot = await mail("From: no-reply@service.example\r\nSubject: Code\r\nMessage-ID: <c@x>", "123456");
  assert.equal(isAutomated(bot), true);
  const bulk = await mail("From: a@x.example\r\nPrecedence: bulk\r\nMessage-ID: <d@x>", "hi");
  assert.equal(isAutomated(bulk), true);
  const auto = await mail("From: a@x.example\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <e@x>", "away");
  assert.equal(isAutomated(auto), true);
  const human = await mail("From: a@x.example\r\nAuto-Submitted: no\r\nMessage-ID: <f@x>", "hi");
  assert.equal(isAutomated(human), false);
  const sent = await mail("From: me@gmail.com\r\nTo: marco@example.com\r\nSubject: Re: Lab swap\r\nMessage-ID: <s@x>\r\nReferences: <a@x> <b@x>", "Deal");
  const row = toMessage(box, sent, 3, "sent", 0);
  assert.deepEqual([row.fromMe, row.sender, row.thread, row.automated], [true, "You", "<a@x>", false]);
  assert.equal(row.extId, "sent:<s@x>");
});

test("a message with no id, subject or date still maps to valid fields", async () => {
  const row = toMessage({ ...box, host: "imap.example.com" }, await mail("From: a@x.example", "hi"), 9, "inbox", 1234);
  assert.equal(row.extId, "inbox:<uid-inbox-9@imap.example.com>");
  assert.equal(row.thread, "<uid-inbox-9@imap.example.com>");
  assert.equal(row.threadName, "(no subject)");
  assert.equal(row.at, 1234);
  assert.equal(row.link, "", "only Gmail gets a link");
});

test("fields are cut to what the dashboard accepts", async () => {
  const long = "x".repeat(600);
  const row = toMessage(box, await mail(`From: ${long} <a@x.example>\r\nSubject: ${long}\r\nMessage-ID: <${long}@x>`, "y".repeat(9000)), 1, "inbox", 1);
  assert.ok(row.extId.length <= 300 && row.thread.length <= 300 && row.sender.length <= 200);
  assert.ok(row.threadName.length <= 200 && row.subject.length <= 300 && row.text.length <= 4000 && row.link.length <= 2000);
});

test("html-only mail is turned into text", async () => {
  const parsed = await PostalMime.parse("From: a@x.example\r\nSubject: Hi\r\nMessage-ID: <h@x>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<style>p{}</style><p>Hello &amp; welcome</p><p>Bye</p>");
  assert.equal(toMessage(box, parsed, 1, "inbox", 1).text, "Hello & welcome\n Bye");
});

test("long text is cut and host:port parsed", () => {
  assert.equal(cleanText("x".repeat(5000)).length, 4000);
  assert.equal(cleanText("Ok.\n\nIl giorno 12 ott 2026 Marco ha scritto:\n> ciao"), "Ok.");
  assert.deepEqual(parseHost("imap.example.com"), { host: "imap.example.com", port: 993 });
  assert.deepEqual(parseHost("IMAP.example.com:143"), { host: "imap.example.com", port: 143 });
  assert.equal(parseHost("https://imap.example.com"), null);
});

test("an empty host turns a mailbox off; a half-filled one says what is missing", () => {
  assert.equal(mailbox(1, {}), null);
  assert.equal(mailbox(1, { mail1Host: "", mail1User: "u", mail1Password: "p" }), null);
  assert.deepEqual(mailbox(1, { mail1Host: "imap.example.com", mail1User: "u" }), { slot: 1, error: "login or password missing" });
  assert.match(mailbox(1, { mail1Host: "https://wrong", mail1User: "u", mail1Password: "p" }).error, /must look like imap\.example\.com/);
  assert.deepEqual(mailbox(3, { mail3Host: "Imap.Example.com:143", mail3User: "u", mail3Password: "p" }), {
    slot: 3, name: "Mail 3", host: "imap.example.com", port: 143, user: "u", password: "p",
  });
});

test("sources are named mail:N, and Gmail gets its own app", () => {
  assert.deepEqual(describe(box), { id: "mail:2", name: "Gmail", app: "gmail", kind: "mail" });
  assert.deepEqual(describe({ ...box, slot: 1, name: "PoliTO", host: "mail.polito.it" }), { id: "mail:1", name: "PoliTO", app: "mail", kind: "mail" });
});

/** A pretend IMAP folder with these UIDs, enough for readFolder. */
function fakeImap(uids, uidNext) {
  const fetched = [];
  const searches = [];
  const raw = (uid) => Buffer.from(`From: a@x\r\nSubject: m${uid}\r\nMessage-ID: <m${uid}@x>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0200\r\n\r\nhi ${uid}`);
  const client = {
    mailbox: { uidValidity: 7n, uidNext },
    async getMailboxLock() { return { release() {} }; },
    async search(q) {
      searches.push(q);
      if (!q.uid) return uids;
      const from = Number(q.uid.split(":")[0]);
      // Like a real server, "n:*" returns the newest message even when it's below n.
      const hits = uids.filter((u) => u >= from);
      return hits.length ? hits : uids.slice(-1);
    },
    async *fetch(list) {
      fetched.push(list);
      for (const uid of list) yield { uid, source: raw(uid), internalDate: new Date() };
    },
  };
  return { client, fetched, searches };
}

/** Dependencies for syncFolder that keep the cursor in memory and record what was sent. */
function fakeDeps({ failSend = false } = {}) {
  const cursors = {};
  const sent = [];
  return {
    cursors,
    sent,
    load: (k) => cursors[k],
    save: (k, v) => { cursors[k] = v; },
    send: async (sources, messages) => {
      if (failSend) throw new Error("the dashboard is down");
      sent.push({ sources, messages });
      return { added: messages.length };
    },
  };
}

test("a backlog over 200 messages is read oldest first across runs, none lost", async () => {
  const { client, fetched } = fakeImap(Array.from({ length: 350 }, (_, i) => i + 1), 351);
  const deps = fakeDeps();
  assert.equal(await syncFolder(client, box, "INBOX", "inbox", deps), 200);
  assert.deepEqual([fetched[0][0], fetched[0].at(-1)], [1, 200]);
  assert.equal(await syncFolder(client, box, "INBOX", "inbox", deps), 150);
  assert.equal(await syncFolder(client, box, "INBOX", "inbox", deps), 0, "the newest message isn't read twice");
  assert.equal(deps.sent.flatMap((s) => s.messages).length, 350);
  assert.deepEqual(deps.sent[0].sources, [{ id: "mail:2", name: "Gmail", app: "gmail", kind: "mail" }]);
});

test("when the dashboard refuses, the cursor stays where it was", async () => {
  const { client } = fakeImap([5, 6], 7);
  const deps = fakeDeps({ failSend: true });
  await assert.rejects(syncFolder(client, box, "INBOX", "inbox", deps), /dashboard is down/);
  assert.deepEqual(deps.cursors, {});
  const ok = fakeDeps();
  assert.equal(await syncFolder(client, box, "INBOX", "inbox", ok), 2, "the next run gets both messages");
  assert.deepEqual(Object.values(ok.cursors), [{ uidValidity: "7", lastUid: 6 }]);
});

test("the first run looks back three days; an empty look-back skips to the newest", async () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const { client, searches } = fakeImap([40, 41], 42);
  const first = await readFolder(client, box, "INBOX", "inbox", undefined, now);
  assert.equal(searches[0].since.getTime(), now - FIRST_LOOK_BACK_MS);
  assert.equal(first.messages.length, 2);
  assert.deepEqual(first.cursor, { uidValidity: "7", lastUid: 41 });
  const quiet = await readFolder(fakeImap([], 42).client, box, "INBOX", "inbox", undefined, now);
  assert.deepEqual(quiet, { messages: [], cursor: { uidValidity: "7", lastUid: 41 } });
});

test("a folder the server renumbered starts again from the look-back", async () => {
  const { client, searches } = fakeImap([1, 2], 3);
  const read = await readFolder(client, box, "INBOX", "inbox", { uidValidity: "6", lastUid: 900 });
  assert.ok(searches[0].since instanceof Date);
  assert.equal(read.messages.length, 2);
  assert.equal(read.cursor.uidValidity, "7");
});

test("messages go to the dashboard at most 500 a call", async () => {
  const calls = [];
  const msgs = Array.from({ length: 1100 }, (_, i) => ({ extId: String(i) }));
  const added = await sendAll(box, msgs, async (sources, batch) => { calls.push(batch.length); return { added: batch.length }; });
  assert.deepEqual(calls, [500, 500, 100]);
  assert.equal(added, 1100);
});

test("errors never show the password", () => {
  assert.match(explain({ authenticationFailed: true, message: "Command failed" }, box), /login failed/);
  assert.equal(explain({ code: "ENOTFOUND", message: "getaddrinfo" }, box), "can't find the server imap.gmail.com");
  assert.ok(!explain(new Error("bad login secret-pw rejected"), box).includes("secret-pw"));
});

test("the status line has one part per mailbox", () => {
  assert.equal(statusLine([{ text: "Mail 1 read 14:05" }, { text: "Mail 2: login failed, check the login and password" }]), "Mail 1 read 14:05, Mail 2: login failed, check the login and password");
  assert.match(statusLine([]), /No mailbox is set up/);
});
