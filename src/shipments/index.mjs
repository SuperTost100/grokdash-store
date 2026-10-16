// Shipments: your parcels at a glance. Reads the shipping mails the dashboard already receives,
// works out which order or parcel each one is about and where it is, and keeps a panel up to date.
// A parcel that's out for delivery or waiting at a pickup point also gets a card.

import { settings, readMessages, panel, post, close, status, every, memory, onAction, log } from "../../sdk/dashboard.mjs";

/** Carriers with a tracking-number shape distinctive enough to trust on its own. */
const CARRIERS = [
  { name: "UPS", re: /\b(1Z[0-9A-Z]{16})\b/, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { name: "Amazon", re: /\b(TBA\d{12})\b/, url: () => "https://www.amazon.it/gp/your-account/order-history" },
  { name: "Cainiao", re: /\b((?:LP|CNIT|CNFR)\d{12,16}|AE\d{9}[A-Z]{2})\b/, url: (n) => `https://global.cainiao.com/newDetail.htm?mailNoList=${n}` },
  { name: "YunExpress", re: /\b(YT\d{16})\b/, url: (n) => `https://www.yuntrack.com/parcelTracking?id=${n}` },
  { name: "Poste Italiane", re: /\b([A-Z]{2}\d{9}IT)\b/, url: (n) => `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${n}` },
  { name: "Postal", re: /\b([A-Z]{2}\d{9}[A-Z]{2})\b/, url: (n) => `https://t.17track.net/en#nums=${n}` },
];
/** Carriers whose numbers are just digits: only trusted next to the carrier's name. */
const NUMERIC = [
  { name: "BRT", word: /\bbrt\b|bartolini/i, re: /\b(\d{12,19})\b/, url: (n) => `https://vas.brt.it/vas/sped_det_show.hsm?Nspediz=${n}` },
  { name: "GLS", word: /\bgls\b/i, re: /\b(\d{11,12})\b/, url: (n) => `https://gls-group.com/IT/it/servizi-online/ricerca-spedizioni?match=${n}` },
  { name: "SDA", word: /\bsda\b/i, re: /\b(\d{12,13})\b/, url: (n) => `https://www.sda.it/wps/portal/Servizi_online/dettaglio-spedizione?locale=it&tracing.letteraVettura=${n}` },
  { name: "DHL", word: /\bdhl\b/i, re: /\b(\d{10,11}|JJD\d{16,18})\b/, url: (n) => `https://www.dhl.com/it-it/home/tracciabilita.html?tracking-id=${n}` },
  { name: "InPost", word: /inpost/i, re: /\b(\d{24})\b/, url: (n) => `https://inpost.it/trova-il-tuo-pacco?number=${n}` },
];
const ORDER = [
  /\b(\d{3}-\d{7}-\d{7})\b/, // Amazon
  /(?:ordine|order)\s*(?:n(?:\.|umero|o\.?)?|#|id)?\s*[:#]?\s*([A-Z0-9-]{6,24}\d)\b/i,
];

/** Ordered by how far along: a later mail can't move a parcel back. */
export const STEPS = [
  { key: "ordered", label: "Ordered", re: /ordine (?:è stato )?(?:confermato|ricevuto)|abbiamo ricevuto il tuo ordine|grazie per (?:il tuo )?ordine|order (?:confirmed|received)|thanks for your order|conferma d'ordine/i },
  { key: "shipped", label: "On the way", re: /spedit[oa]|è stato spedito|in transito|partit[oa]|affidat[oa] al corriere|shipped|has shipped|in transit|on (?:its|the) way|dispatched|tracking/i },
  { key: "today", label: "Arriving today", re: /in consegna|arriva oggi|consegna (?:prevista )?(?:per )?oggi|out for delivery|arriving today|will be delivered today/i },
  { key: "pickup", label: "Ready for pickup", re: /pronto (?:per il |al )?ritiro|disponibile (?:per il ritiro|presso)|ritira(?:lo)? (?:entro|presso)|locker|punto di ritiro|ready for (?:pickup|collection)|available for pickup/i },
  { key: "delivered", label: "Delivered", re: /è stato consegnato|consegnat[oa]|abbiamo consegnato|delivered|has been delivered|ritirat[oa]/i },
];
const SHIPPING = /spedizion|spedit|consegn|pacco|corriere|tracking|tracciament|ordine|order|shipment|shipped|deliver|package|parcel|ritiro|locker/i;
const NOT_SHIPPING = /newsletter|% di sconto|\boffert[ae]\b|unsubscribe|annulla l'iscrizione|password|codice di verifica|verification code/i;

const MERCHANTS = [
  ["Amazon", /amazon/i], ["AliExpress", /aliexpress/i], ["eBay", /ebay/i], ["Zalando", /zalando/i], ["Temu", /temu/i],
  ["Shein", /shein/i], ["Vinted", /vinted/i], ["Subito", /subito/i], ["IKEA", /ikea/i], ["Decathlon", /decathlon/i],
];

function merchantOf(m) {
  const where = `${m.sender} ${m.threadName} ${m.subject}`;
  for (const [name, re] of MERCHANTS) if (re.test(where)) return name;
  // "Shop name <orders@shop.it>": the display name, without "noreply" and friends.
  const name = m.sender.replace(/<[^>]*>/g, "").replace(/\b(no-?reply|notifiche|notifications?|orders?|ordini|info)\b/gi, "").replace(/["']/g, "").trim();
  return name.slice(0, 40) || "A shop";
}

/**
 * What one mail says about a parcel, or null when it isn't about one.
 * Returns the key that ties mails about the same parcel or order together.
 */
export function detect(m) {
  const text = `${m.subject}\n${m.text}`.slice(0, 20_000);
  if (m.fromMe || !SHIPPING.test(text) || NOT_SHIPPING.test(m.subject)) return null;
  let carrier = null;
  let tracking = "";
  for (const c of CARRIERS) {
    const hit = c.re.exec(text);
    if (hit) { carrier = c; tracking = hit[1]; break; }
  }
  if (!carrier) {
    for (const c of NUMERIC) {
      if (!c.word.test(text)) continue;
      const hit = c.re.exec(text);
      if (hit) { carrier = c; tracking = hit[1]; break; }
    }
  }
  let order = "";
  for (const re of ORDER) {
    const hit = re.exec(text);
    if (hit && hit[1] !== tracking) { order = hit[1]; break; }
  }
  // The furthest step any sentence of the subject, then the body, mentions.
  const subjectStep = STEPS.findLastIndex((s) => s.re.test(m.subject));
  const step = subjectStep >= 0 ? subjectStep : STEPS.findLastIndex((s) => s.re.test(m.text.slice(0, 3000)));
  if (step < 0 && !tracking) return null;
  if (!tracking && !order) return null;
  return {
    key: tracking ? `t:${tracking}` : `o:${order}`,
    tracking, order,
    carrier: carrier?.name ?? "",
    link: carrier ? carrier.url(tracking) : m.link || "",
    merchant: merchantOf(m),
    step: Math.max(step, tracking ? 1 : 0),
    at: m.at,
    subject: m.subject.slice(0, 120),
  };
}

/** Fold one detection into the list. Mails about the same order and its parcel end up in one entry. */
export function fold(list, d) {
  let s = list.find((x) => x.key === d.key || (d.order && x.order === d.order) || (d.tracking && x.tracking === d.tracking));
  if (!s) {
    s = { key: d.key, tracking: "", order: "", carrier: "", link: "", merchant: d.merchant, step: 0, firstAt: d.at, at: d.at, subject: d.subject };
    list.push(s);
  }
  if (d.tracking && !s.tracking) Object.assign(s, { tracking: d.tracking, carrier: d.carrier, link: d.link, key: d.key });
  if (d.order && !s.order) s.order = d.order;
  if (d.step > s.step || (d.step === s.step && d.at > s.at)) Object.assign(s, { step: Math.max(s.step, d.step), at: Math.max(s.at, d.at), subject: d.subject });
  return s;
}

const DAY = 86_400_000;

/** Delivered parcels stay two days; anything silent for three weeks is dropped as stale. */
export function prune(list, now) {
  return list.filter((s) => (s.step === 4 ? now - s.at < 2 * DAY : now - s.at < 21 * DAY));
}

function render(list, now) {
  const open = list.filter((s) => s.step < 4).sort((a, b) => b.step - a.step || b.at - a.at);
  const done = list.filter((s) => s.step === 4);
  const when = (t) => {
    const days = Math.floor((now - t) / DAY);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  };
  const item = (s) => ({
    title: `${s.merchant}${s.order ? ` · ${s.order}` : ""}`,
    sub: [s.carrier, s.tracking, `updated ${when(s.at)}`].filter(Boolean).join(" · "),
    badge: STEPS[s.step].label,
    ...(s.link ? { link: s.link } : {}),
  });
  const blocks = [
    { type: "stats", items: [
      { label: "On the way", value: String(open.filter((s) => s.step <= 1).length) },
      { label: "Arriving today", value: String(open.filter((s) => s.step === 2).length) },
      { label: "To pick up", value: String(open.filter((s) => s.step === 3).length) },
    ] },
  ];
  if (open.length) blocks.push({ type: "list", items: open.slice(0, 30).map(item) });
  if (done.length) blocks.push({ type: "list", items: done.slice(0, 10).map(item) });
  if (!list.length) blocks.push({ type: "text", text: "No parcels in your mail from the last three weeks." });
  blocks.push({ type: "buttons", items: [{ label: "Read my mail again" }] });
  return blocks;
}

async function cards(list) {
  for (const s of list) {
    const key = `parcel:${s.key}`;
    if (s.step === 2 || s.step === 3) {
      await post({
        key, kind: "reminder", app: "",
        title: s.step === 3 ? `${s.merchant} parcel is ready for pickup` : `${s.merchant} parcel arrives today`,
        body: [s.subject, s.carrier && s.tracking ? `${s.carrier} ${s.tracking}` : ""].filter(Boolean).join("\n"),
        source: "Shipments",
        ...(s.link ? { link: s.link } : {}),
        ...(s.step === 3 ? { urgent: "Pick it up" } : {}),
      });
    } else if (s.step === 4 && s.carded) {
      await close(key, "Delivered").catch(() => {});
    }
    if (s.step === 2 || s.step === 3) s.carded = true;
  }
}

let state = memory.load("shipments", { after: 0, list: [] });

async function sync(again = false) {
  if (again) state = { after: 0, list: [] };
  for (let page = 0; page < 20; page++) {
    const got = await readMessages(state.after, "mail", 200);
    for (const m of got.messages) {
      const d = detect(m);
      if (d) fold(state.list, d);
    }
    state.after = got.last;
    if (got.messages.length < 200) break;
  }
  state.list = prune(state.list, Date.now());
  await cards(state.list);
  await panel("Shipments", render(state.list, Date.now()));
  memory.save("shipments", state);
  const open = state.list.filter((s) => s.step < 4).length;
  await status(`${open} parcel${open === 1 ? "" : "s"} on the way, read ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: process.env.TZ })}`);
}

if (process.env.DASH_URL) {
  every(Math.max(1, Number(settings.every) || 10) * 60_000, () => sync());
  onAction(async (a) => {
    if (a.type === "panel") {
      await sync(true);
      log("read the mail again");
      return { ok: true, result: "Read the last two weeks of mail again" };
    }
    // A closed card is just closed: the parcel stays on the panel until it's delivered.
    return { ok: true };
  });
}
