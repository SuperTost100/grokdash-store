import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, fold, prune, STEPS } from "../src/shipments/index.mjs";

const mail = (subject, text, extra = {}) => ({ source: "mail:1", sender: "Amazon.it <spedizioni@amazon.it>", threadName: subject, subject, text, fromMe: false, at: Date.parse("2026-10-16T09:00:00Z"), link: "", ...extra });
const step = (key) => STEPS.findIndex((s) => s.key === key);

test("Italian and English shipping mails: the parcel, its carrier and how far along it is", () => {
  const shipped = detect(mail("Il tuo ordine è stato spedito", "Ordine n. 405-1234567-1234567\nNumero di tracciamento: 1Z999AA10123456784 (UPS)"));
  assert.deepEqual([shipped.key, shipped.carrier, shipped.order, shipped.step, shipped.merchant], ["t:1Z999AA10123456784", "UPS", "405-1234567-1234567", step("shipped"), "Amazon"]);
  assert.match(shipped.link, /ups\.com.*1Z999AA10123456784/);
  const today = detect(mail("Your package is out for delivery", "Order #405-1234567-1234567 arrives today."));
  assert.deepEqual([today.key, today.step], ["o:405-1234567-1234567", step("today")]);
  const poste = detect(mail("La tua spedizione è disponibile per il ritiro", "Spedizione RR123456789IT presso Punto Poste Torino", { sender: "Poste Italiane <noreply@posteitaliane.it>" }));
  assert.deepEqual([poste.carrier, poste.step], ["Poste Italiane", step("pickup")]);
  const brt = detect(mail("Spedizione BRT in consegna", "Il corriere BRT consegna oggi la spedizione 123456789012345", { sender: "BRT <noreply@brt.it>" }));
  assert.deepEqual([brt.carrier, brt.tracking], ["BRT", "123456789012345"]);
});

test("not every mail with 'ordine' is a parcel", () => {
  assert.equal(detect(mail("Offerte della settimana: 50% di sconto", "Ordina ora, spedizione gratuita")), null);
  assert.equal(detect(mail("Il tuo codice di verifica", "Codice 123456 per il tuo ordine")), null);
  assert.equal(detect(mail("Ciao", "Ci vediamo domani")), null);
  assert.equal(detect(mail("Il tuo ordine è stato spedito", "Spedito oggi", { fromMe: true })), null);
  assert.equal(detect(mail("Spedito!", "Il pacco è partito ma non c'è un numero")), null, "no number or order: nothing to follow");
});

test("mails about one order and its parcel become one entry that only moves forward", () => {
  const list = [];
  fold(list, detect(mail("Ordine confermato", "Grazie per il tuo ordine 405-1234567-1234567")));
  fold(list, detect(mail("Spedito", "Ordine 405-1234567-1234567, tracciamento 1Z999AA10123456784", { at: Date.parse("2026-10-17T09:00:00Z") })));
  fold(list, detect(mail("Il tuo ordine è stato spedito", "Ordine 405-1234567-1234567", { at: Date.parse("2026-10-17T10:00:00Z") })));
  fold(list, detect(mail("Consegnato", "Il pacco 1Z999AA10123456784 è stato consegnato", { at: Date.parse("2026-10-18T12:00:00Z") })));
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].tracking, list[0].order, list[0].step], ["1Z999AA10123456784", "405-1234567-1234567", step("delivered")]);
  fold(list, detect(mail("Spedito", "tracciamento 1Z999AA10123456784", { at: Date.parse("2026-10-18T13:00:00Z") })));
  assert.equal(list[0].step, step("delivered"), "an old 'shipped' mail doesn't move it back");
  assert.equal(prune(list, Date.parse("2026-10-19T12:00:00Z")).length, 1);
  assert.equal(prune(list, Date.parse("2026-10-21T12:00:00Z")).length, 0, "delivered parcels go after two days");
});
