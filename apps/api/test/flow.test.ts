import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { dueReminders, evaluateOrder, manualReminderCheck, markReviewReceived, scheduleManualReminder } from "../src/campaigns/engine.js";
import { recoverStuckSending, sendDueInvitations } from "../src/campaigns/sender.js";
import { resetConfig } from "../src/config.js";
import { formatDateDe } from "../src/domain/time.js";
import { EmailSendError, MemoryTransport, setEmailTransport } from "../src/email/transport.js";
import { hashPassword } from "../src/lib/crypto.js";
import { db, disconnectDb } from "../src/lib/db.js";
import { handlers, processWebhook, setShopifyClient } from "../src/jobs/handlers.js";
import { enqueue, releaseStale, runOnce } from "../src/jobs/queue.js";
import { saveJudgemeConfig, testJudgeme, hasJudgemeReviewSince } from "../src/platforms/judgeme.js";
import { syncJudgemeReviews } from "../src/platforms/reviewSync.js";
import { ShopifyClient } from "../src/shopify/client.js";
import { addOrder, campaign, invitations, makeOrder, resetDb, setupShop } from "./helpers.js";
import { upsertOrder } from "../src/shopify/sync.js";

const TZ = "Europe/Berlin";
const day = (d: Date | null | undefined) => formatDateDe(d, TZ);
let mail: MemoryTransport;
let shopId: string;

beforeEach(async () => {
  await resetDb();
  mail = new MemoryTransport();
  setEmailTransport(mail);
  shopId = await setupShop();
});
afterAll(async () => {
  setEmailTransport(undefined);
  await disconnectDb();
});

/** Drei Stufen nur, wenn Plattform UND globale Einstellung Erinnerungen erlauben (für Google standardmäßig aus) */
async function enableThreeSteps(): Promise<void> {
  await db().reviewRule.update({ where: { shopId }, data: { remindersOnUnknownStatus: true } });
  await db().reviewPlatform.update({ where: { shopId_key: { shopId, key: "GOOGLE_BUSINESS" } }, data: { remindersAllowed: true } });
}

describe("Phase-4-Szenarien", () => {
  it("normale DHL-Bestellung: Zustellung 01.12. → Anfrage 05.12. (eine Stufe, da Status unbekannt)", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    expect(await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"))).toBe("SCHEDULED");
    const inv = await invitations(id);
    expect(inv.map((i) => day(i.scheduledAt))).toEqual(["05.12.2026"]);
    expect((await campaign(id))?.shippingRule).toBe("TRACKED");
  });

  it("Google-Standard: genau eine Anfrage, auch wenn Erinnerungen global erlaubt sind", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { remindersOnUnknownStatus: true } });
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect(await invitations(id)).toHaveLength(1);
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(1);
    expect(await sendDueInvitations(new Date("2026-12-08T08:01:00Z"))).toBe(0);
    expect((await campaign(id))?.status).toBe("REVIEW_STATUS_UNKNOWN");
  });

  it("Versanddrosselung: max. 5 pro Durchgang, nächster Durchgang erst nach 10 Minuten", async () => {
    for (let i = 0; i < 7; i++) {
      const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
      await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    }
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(5);
    expect(await sendDueInvitations(new Date("2026-12-05T08:06:00Z"))).toBe(0); // Pause läuft noch
    expect(await sendDueInvitations(new Date("2026-12-05T08:11:00Z"))).toBe(2);
    expect(mail.sent).toHaveLength(7);
  });

  it("idealo-Bestellung erhält die idealo-Anfrage mit Bestellnummer, andere die Google-Anfrage", async () => {
    await db().reviewPlatform.update({ where: { shopId_key: { shopId, key: "IDEALO" } }, data: { active: true, reviewUrl: "https://www.idealo.de/preisvergleich/ShopRatingForm/336477.html" } });
    const viaIdealo = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", utmSource: "idealo" });
    const direct = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(viaIdealo, new Date("2026-12-02T10:00:00Z"));
    await evaluateOrder(direct, new Date("2026-12-02T10:00:00Z"));
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(2);
    const idealoMail = mail.sent.find((m) => m.subject.includes("idealo"))!;
    const order = await db().order.findUniqueOrThrow({ where: { id: viaIdealo } });
    expect(idealoMail.text).toContain(`Bestellnummer: ${order.name}`);
    expect(mail.sent.filter((m) => m.subject.includes("auf Google"))).toHaveLength(1);
    const r = await (await buildApp({ serveWeb: false })).inject({ method: "GET", url: `/r/${(await invitations(viaIdealo))[0]!.trackingToken}` });
    expect(r.headers.location).toBe("https://www.idealo.de/preisvergleich/ShopRatingForm/336477.html");
  });

  it("manuelle Erinnerung: erst nach Versand, Mindestabstand 3 Tage, max. 3 Kontakte, danach wieder geschlossen", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    const c = (await campaign(id))!;
    expect(await manualReminderCheck(c.id, new Date("2026-12-02T10:00:00Z"))).toMatchObject({ ok: false });

    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    expect((await campaign(id))?.status).toBe("REVIEW_STATUS_UNKNOWN");

    // am selben Tag ausgelöst → frühestens 3 Tage nach der ersten Mail
    const r = await scheduleManualReminder(c.id, "test", new Date("2026-12-05T10:00:00Z"));
    expect(r.step).toBe(2);
    expect(r.scheduledAt.getTime()).toBeGreaterThanOrEqual(new Date("2026-12-08T08:00:00Z").getTime());
    expect((await campaign(id))?.status).toBe("ACTIVE");
    await expect(scheduleManualReminder(c.id, "test", new Date("2026-12-05T10:00:00Z"))).rejects.toThrow(/bereits eine Einladung geplant/);

    // automatischer Planungslauf darf die manuelle Erinnerung nicht abbrechen
    await evaluateOrder(id, new Date("2026-12-06T10:00:00Z"));
    expect((await invitations(id)).find((i) => i.step === 2)?.status).toBe("SCHEDULED");

    expect(await sendDueInvitations(new Date(r.scheduledAt.getTime() + 60_000))).toBe(1);
    expect(mail.sent.at(-1)!.subject).toBe("Deine Meinung zu Adfunture ist uns wichtig");
    expect((await campaign(id))?.status).toBe("REVIEW_STATUS_UNKNOWN");

    const r3 = await scheduleManualReminder(c.id, "test", new Date("2026-12-12T10:00:00Z"));
    expect(r3.step).toBe(3);
    await sendDueInvitations(new Date(r3.scheduledAt.getTime() + 60_000));
    expect(await manualReminderCheck(c.id, new Date("2026-12-20T10:00:00Z"))).toMatchObject({ ok: false, reason: expect.stringMatching(/Maximal 3/) });
    expect(mail.sent).toHaveLength(3);
  });

  it("überfällige Einladung wird nachts nicht versendet, sondern auf den nächsten Versandbeginn verschoben", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    // 22:30 Uhr Berlin (z. B. Freigabe am Abend) → kein Versand
    expect(await sendDueInvitations(new Date("2026-12-05T21:30:00Z"))).toBe(0);
    const inv = (await invitations(id))[0]!;
    expect(inv.status).toBe("SCHEDULED");
    expect(inv.scheduledAt.toISOString()).toBe("2026-12-06T08:00:00.000Z"); // 09:00 Berlin
    expect(await sendDueInvitations(new Date("2026-12-06T08:01:00Z"))).toBe(1);
  });

  it("Liste „Erinnerung fällig“: erst nach Mindestabstand, nicht bei bestätigter Bewertung, Sammel-Einplanung", async () => {
    const a = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    const b = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(a, new Date("2026-12-02T10:00:00Z"));
    await evaluateOrder(b, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const ca = (await campaign(a))!;
    const cb = (await campaign(b))!;
    expect((await dueReminders(shopId, new Date("2026-12-06T10:00:00Z"))).size).toBe(0); // Mindestabstand 3 Tage
    const due = await dueReminders(shopId, new Date("2026-12-08T10:00:00Z"));
    expect([...due.keys()].sort()).toEqual([ca.id, cb.id].sort());
    expect(due.get(ca.id)?.step).toBe(2);

    await markReviewReceived(cb.id, "manuell bestätigt");
    expect([...(await dueReminders(shopId, new Date("2026-12-08T10:00:00Z"))).keys()]).toEqual([ca.id]);

    await scheduleManualReminder(ca.id, "test", new Date("2026-12-08T10:00:00Z"));
    expect((await dueReminders(shopId, new Date("2026-12-08T10:00:00Z"))).size).toBe(0); // bereits eingeplant
    // nach 30 Tagen ohne Kontakt wird keine Erinnerung mehr angeboten
    expect((await dueReminders(shopId, new Date("2027-02-01T10:00:00Z"))).size).toBe(0);
  });

  it("manuelle Erinnerung respektiert Abmeldung, Storno und bestätigte Bewertung", async () => {
    const order = makeOrder({ deliveredAt: "2026-12-01T14:00:00+01:00", email: "manuell@example.test" });
    const id = await upsertOrder(shopId, order);
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const c = (await campaign(id))!;
    const r = await scheduleManualReminder(c.id, "test", new Date("2026-12-09T10:00:00Z"));
    // Kunde meldet sich ab, bevor die Erinnerung rausgeht
    await db().emailSuppression.create({ data: { shopId, email: "manuell@example.test", reason: "UNSUBSCRIBED" } });
    expect(await sendDueInvitations(new Date(r.scheduledAt.getTime() + 60_000))).toBe(0);
    expect((await campaign(id))?.status).toBe("CANCELLED");

    const id2 = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id2, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const c2 = (await campaign(id2))!;
    await markReviewReceived(c2.id, "Test");
    expect(await manualReminderCheck(c2.id)).toMatchObject({ ok: false, reason: "Bewertung liegt bereits vor" });
  });

  it("drei Stufen nur bei ausdrücklich erlaubten Erinnerungen: 05./08./11.12.", async () => {
    await enableThreeSteps();
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect((await invitations(id)).map((i) => day(i.scheduledAt))).toEqual(["05.12.2026", "08.12.2026", "11.12.2026"]);
  });

  it("GLS unterwegs → Variante B; spätere Zustellbestätigung plant auf Variante A um", async () => {
    const order = makeOrder({ carrier: "GLS", displayStatus: "IN_TRANSIT" });
    const id = await upsertOrder(shopId, order);
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect((await campaign(id))?.shippingRule).toBe("UNTRACKED_FALLBACK");
    expect(day((await invitations(id))[0]!.scheduledAt)).toBe("15.12.2026");

    const delivered = { ...order, shopifyUpdatedAt: new Date("2026-12-04T12:00:00Z") };
    delivered.fulfillments = [{ ...order.fulfillments[0]!, displayStatus: "DELIVERED", deliveredAt: new Date("2026-12-04T11:00:00Z") }];
    await upsertOrder(shopId, delivered);
    await evaluateOrder(id, new Date("2026-12-04T12:00:00Z"));
    expect((await campaign(id))?.shippingRule).toBe("TRACKED");
    expect(day((await invitations(id))[0]!.scheduledAt)).toBe("08.12.2026");
  });

  it("Speditionsbestellung ohne Tracking → 14 Tage nach Bestellung", async () => {
    const id = await addOrder(shopId, { carrier: null, trackingNumber: null, shippingMethod: "Speditionsversand Dachbox" });
    const order = await db().order.findUniqueOrThrow({ where: { id } });
    expect(order).toMatchObject({ isFreight: true, hasTracking: false, deliveryStatus: "DELIVERY_UNKNOWN" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect(day((await invitations(id))[0]!.scheduledAt)).toBe("15.12.2026");
  });

  it("Bestellung ohne Fulfillment: keine Einladung, auch nicht nach 14 Tagen", async () => {
    const id = await addOrder(shopId, { shipped: false });
    expect(await evaluateOrder(id, new Date("2026-12-16T10:00:00Z"))).toBe("PENDING");
    expect(await invitations(id)).toHaveLength(0);
  });

  it("stornierte Bestellung beendet geplante Kampagne", async () => {
    const order = makeOrder({ deliveredAt: "2026-12-01T14:00:00+01:00" });
    const id = await upsertOrder(shopId, order);
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await upsertOrder(shopId, { ...order, cancelledAt: new Date("2026-12-03T10:00:00Z"), shopifyUpdatedAt: new Date("2026-12-03T10:00:00Z") });
    expect(await evaluateOrder(id, new Date("2026-12-03T11:00:00Z"))).toBe("CANCELLED");
    expect((await invitations(id))[0]!.status).toBe("CANCELLED");
  });

  it("verzögerte Lieferung pausiert, Zustellung setzt fort", async () => {
    const order = makeOrder({ displayStatus: "DELAYED" });
    const id = await upsertOrder(shopId, order);
    expect(await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"))).toBe("PAUSED");
    await upsertOrder(shopId, {
      ...order,
      shopifyUpdatedAt: new Date("2026-12-06T10:00:00Z"),
      fulfillments: [{ ...order.fulfillments[0]!, displayStatus: "DELIVERED", deliveredAt: new Date("2026-12-06T09:00:00Z") }],
    });
    expect(await evaluateOrder(id, new Date("2026-12-06T10:00:00Z"))).toBe("SCHEDULED");
    expect(day((await invitations(id))[0]!.scheduledAt)).toBe("10.12.2026");
  });

  it("bereits bewertete Bestellung: kein Versand", async () => {
    await enableThreeSteps();
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await markReviewReceived((await campaign(id))!.id, "Test");
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(0);
    expect(mail.sent).toHaveLength(0);
    expect((await campaign(id))?.status).toBe("REVIEW_RECEIVED");
  });

  it("Kunde ohne Einwilligung (Einwilligungsmodell) → CONSENT_MISSING; mit Shopify-Opt-in → geplant", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { legalBasis: "CONSENT" } });
    const a = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    expect(await evaluateOrder(a, new Date("2026-12-02T10:00:00Z"))).toBe("CONSENT_MISSING");
    const b = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", marketingState: "SUBSCRIBED" });
    expect(await evaluateOrder(b, new Date("2026-12-02T10:00:00Z"))).toBe("SCHEDULED");
  });

  it("jede Bestellung: Standard-Shop ist auf § 7 Abs. 3 UWG voreingestellt, Kunden ohne Marketing-Einwilligung werden angefragt, erstattete auch", async () => {
    const fresh = await (await import("../src/services/bootstrap.js")).ensureShop("neu-shop.myshopify.com", "Neu");
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: fresh } });
    expect(rule).toMatchObject({ legalBasis: "UWG_7_3", includeRefundedOrders: true, sendingEnabled: false });
    const google = await db().reviewPlatform.findFirstOrThrow({ where: { shopId: fresh, key: "GOOGLE_BUSINESS" } });
    expect(google).toMatchObject({ targetShare: 100, remindersAllowed: false });

    await db().reviewRule.update({ where: { shopId }, data: { includeRefundedOrders: true } });
    const a = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", marketingState: "NOT_SUBSCRIBED" });
    const b = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", refunded: 100 });
    expect(await evaluateOrder(a, new Date("2026-12-02T10:00:00Z"))).toBe("SCHEDULED");
    expect(await evaluateOrder(b, new Date("2026-12-02T10:00:00Z"))).toBe("SCHEDULED");
    await db().reviewRule.update({ where: { shopId }, data: { includeRefundedOrders: false } });
    const c = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", refunded: 100 });
    expect(await evaluateOrder(c, new Date("2026-12-02T10:00:00Z"))).toBe("CANCELLED");
  });

  it("fehlende Rechtsgrundlage → kein Versand", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { legalBasis: "NONE" } });
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    expect(await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"))).toBe("CONSENT_MISSING");
  });

  it("Versand erst nach Freigabe – vorher wird nichts verschickt", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { sendingEnabled: false } });
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(0);
    expect((await invitations(id))[0]!.status).toBe("SCHEDULED");
  });

  it("ALLOW_CUSTOMER_EMAILS=false blockiert hart", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    process.env.ALLOW_CUSTOMER_EMAILS = "false";
    resetConfig();
    try {
      expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(0);
    } finally {
      process.env.ALLOW_CUSTOMER_EMAILS = "true";
      resetConfig();
    }
    expect(mail.sent).toHaveLength(0);
  });

  it("Versand: E-Mail mit Abmeldelink, Klicklink und Zuordnung; Status unbekannt → Kampagne endet ohne Erinnerung", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "anna@example.test" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(1);
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0]!;
    expect(m.to).toBe("anna@example.test");
    // Google-Plattform → Google-spezifische Vorlage
    expect(m.subject).toBe("Wie zufrieden bist du mit Adfunture? Teile deine Erfahrung auf Google");
    expect(m.text).toContain("ganz gleich, wie sie ausgefallen ist");
    expect(m.text).toMatch(/vielen Dank für deine Bestellung #\d+ bei Adfunture/);
    expect(m.text).toContain("https://reviews.example.test/r/");
    expect(m.text).toContain("https://reviews.example.test/u/");
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const c = await campaign(id);
    expect(c?.status).toBe("REVIEW_STATUS_UNKNOWN");
    const ev = await db().emailEvent.findMany({ where: { type: "SENT" } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.invitationId).toBe((await invitations(id))[0]!.id);
    // erneuter Lauf → keine Doppel-Mail
    expect(await sendDueInvitations(new Date("2026-12-05T09:00:00Z"))).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it("drei Kontaktversuche mit freigeschalteten Erinnerungen, danach abgeschlossen", async () => {
    await enableThreeSteps();
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    for (const t of ["2026-12-05T08:01:00Z", "2026-12-08T08:01:00Z", "2026-12-11T08:01:00Z"]) expect(await sendDueInvitations(new Date(t))).toBe(1);
    expect(mail.sent.map((m) => m.subject)).toEqual([
      "Wie zufrieden bist du mit Adfunture? Teile deine Erfahrung auf Google",
      "Deine Meinung zu Adfunture ist uns wichtig",
      "Eine letzte Bitte um dein Feedback",
    ]);
    expect((await campaign(id))?.status).toBe("REVIEW_STATUS_UNKNOWN");
    expect(await sendDueInvitations(new Date("2026-12-14T08:01:00Z"))).toBe(0);
  });

  it("keine rückwirkende Massenversendung nach langer Sperre", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { sendingEnabled: false } });
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await db().reviewRule.update({ where: { shopId }, data: { sendingEnabled: true } });
    expect(await sendDueInvitations(new Date("2026-12-20T08:00:00Z"))).toBe(0);
    expect((await invitations(id))[0]!.status).toBe("SKIPPED");
    expect((await campaign(id))?.status).toBe("CANCELLED");
  });

  it("Erstimport alter Bestellungen plant nichts rückwirkend", async () => {
    const id = await addOrder(shopId, { createdAt: "2026-09-01T10:00:00Z", deliveredAt: "2026-09-03T10:00:00Z" });
    expect(await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"))).toBe("CANCELLED");
    expect((await invitations(id)).filter((i) => i.status === "SCHEDULED")).toHaveLength(0);
  });

  it("fehlerhafter E-Mail-Versand: vorübergehend → Retry mit Backoff; harter Bounce → Sperre + Abbruch", async () => {
    const a = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(a, new Date("2026-12-02T10:00:00Z"));
    mail.failNext = new EmailSendError("421 try again", false, false);
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(0);
    const inv = (await invitations(a))[0]!;
    expect(inv).toMatchObject({ status: "SCHEDULED", attempts: 1 });
    expect(inv.scheduledAt.getTime()).toBeGreaterThan(Date.now());

    const b = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "weg@example.test" });
    await evaluateOrder(b, new Date("2026-12-02T10:00:00Z"));
    mail.failNext = new EmailSendError("550 user unknown", true, true);
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    expect(await db().emailSuppression.count({ where: { email: "weg@example.test", reason: "HARD_BOUNCE" } })).toBe(1);
    expect((await campaign(b))?.status).toBe("CANCELLED");
  });

  it("Railway-Neustart: hängender Versand wird nie doppelt gesendet, hängende Jobs laufen weiter", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    const inv = (await invitations(id))[0]!;
    await db().$executeRaw`UPDATE review_invitations SET status = 'SENDING', updated_at = now() - interval '1 hour' WHERE id = ${inv.id}::uuid`;
    expect(await recoverStuckSending()).toBe(1);
    await evaluateOrder(id, new Date("2026-12-05T08:00:00Z"));
    expect(await sendDueInvitations(new Date("2026-12-05T08:01:00Z"))).toBe(0);
    expect((await invitations(id))[0]!.status).toBe("FAILED");

    await enqueue("plan-campaigns", {}, { dedupeKey: "restart-test" });
    await db().$executeRaw`UPDATE jobs SET status = 'RUNNING', locked_at = now() - interval '1 hour', attempts = 1 WHERE dedupe_key = 'restart-test'`;
    expect(await releaseStale()).toBe(1);
    await db().$executeRaw`UPDATE jobs SET run_at = now() - interval '1 second' WHERE dedupe_key = 'restart-test'`;
    expect(await runOnce(handlers)).toBe(true);
    expect((await db().job.findUnique({ where: { dedupeKey: "restart-test" } }))?.status).toBe("DONE");
  });

  it("Job-Queue: Retry mit Backoff, danach Dead Letter; dedupeKey verhindert Duplikate", async () => {
    expect(await enqueue("unbekannt", {}, { dedupeKey: "x", maxAttempts: 2 })).toBe(true);
    expect(await enqueue("unbekannt", {}, { dedupeKey: "x" })).toBe(false);
    await runOnce(handlers);
    let job = await db().job.findUniqueOrThrow({ where: { dedupeKey: "x" } });
    expect(job.status).toBe("FAILED");
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    await db().job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await runOnce(handlers);
    job = await db().job.findUniqueOrThrow({ where: { dedupeKey: "x" } });
    expect(job.status).toBe("DEAD");
  });

  it("fehlende Plattform-API (Judge.me 401) wird ehrlich angezeigt, keine Synchronisierung", async () => {
    await saveJudgemeConfig(shopId, { shopDomain: "test-shop.myshopify.com", apiToken: "token-ungueltig-123" });
    const fake = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const res = await testJudgeme(shopId, fake);
    expect(res.ok).toBe(false);
    const row = await db().shopIntegration.findFirstOrThrow({ where: { provider: "judgeme" } });
    expect(row.status).toBe("ERROR");
    expect(row.encryptedConfig).not.toContain("token-ungueltig");
    expect(await syncJudgemeReviews(shopId, fake)).toBe(0);
    expect(await hasJudgemeReviewSince(shopId, "a@b.de", new Date(), fake)).toBeUndefined();
  });

  it("Judge.me erreichbar: vorhandene Bewertung beendet die Kampagne", async () => {
    await db().reviewRule.update({ where: { shopId }, data: { considerJudgemeInvitations: true } });
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "fan@example.test" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await saveJudgemeConfig(shopId, { shopDomain: "test-shop.myshopify.com", apiToken: "token-gueltig-123" });
    const fake = (async () => Response.json({ reviews: [{ id: 77, rating: 5, created_at: "2026-12-03T10:00:00Z", reviewer: { email: "fan@example.test" } }] })) as unknown as typeof fetch;
    expect((await testJudgeme(shopId, fake)).ok).toBe(true);
    expect(await syncJudgemeReviews(shopId, fake, 1)).toBe(1);
    expect((await campaign(id))?.status).toBe("REVIEW_RECEIVED");
  });

  it("Bestellung sperren und Sperre wieder aufheben; Kundensperre wird im Detail angezeigt", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "sperre@example.test" });
    await evaluateOrder(id);
    expect((await campaign(id))?.status).toBe("SCHEDULED");
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);

    const blocked = await app.inject({ method: "POST", url: `/api/orders/${id}/block`, headers: { cookie }, payload: { reason: "Kundenwunsch" } });
    expect(blocked.json().campaignStatus).toBe("CANCELLED");
    expect((await invitations(id)).every((i) => i.status === "CANCELLED")).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/orders", headers: { cookie } });
    expect(list.json().rows.find((r: { id: string }) => r.id === id).blocked).toBe(true);

    const unblocked = await app.inject({ method: "POST", url: `/api/orders/${id}/unblock`, headers: { cookie } });
    expect(unblocked.json().campaignStatus).toBe("SCHEDULED");
    expect((await invitations(id)).some((i) => i.status === "SCHEDULED")).toBe(true);

    await app.inject({ method: "POST", url: "/api/suppressions", headers: { cookie }, payload: { email: "sperre@example.test", reason: "MANUAL" } });
    const detail = await app.inject({ method: "GET", url: `/api/orders/${id}`, headers: { cookie } });
    expect(detail.json().customerSuppressed).toBe(true);
    expect((await campaign(id))?.status).toBe("CANCELLED");
    await app.close();
  });

  it("Mandantentrennung: Kampagnen anderer Shops sind nicht erreichbar", async () => {
    const other = await setupShop("anderer-shop.myshopify.com");
    const id = await addOrder(other, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);
    const c = await campaign(id);
    const res = await app.inject({ method: "POST", url: `/api/campaigns/${c!.id}/pause`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

async function login(app: Awaited<ReturnType<typeof buildApp>>, forShop: string, role: "OWNER" | "ADMIN" | "VIEWER" = "OWNER"): Promise<string> {
  const email = `admin-${role.toLowerCase()}-${forShop.slice(0, 6)}@example.test`;
  await db().user.create({ data: { email, passwordHash: await hashPassword("passwort-123"), role, shopId: forShop } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "passwort-123" } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers["set-cookie"];
  return String(Array.isArray(raw) ? raw[0] : raw).split(";")[0]!;
}

describe("HTTP-Schnittstellen", () => {
  function signed(body: string): string {
    return createHmac("sha256", "test-secret").update(body).digest("base64");
  }

  it("doppelte Webhooks werden nur einmal angenommen; falsche Signatur → 401", async () => {
    const app = await buildApp({ serveWeb: false });
    const body = JSON.stringify({ id: 4242, admin_graphql_api_id: "gid://shopify/Order/4242" });
    const headers = { "content-type": "application/json", "x-shopify-topic": "orders/updated", "x-shopify-shop-domain": "test-shop.myshopify.com", "x-shopify-webhook-id": "wh-1", "x-shopify-hmac-sha256": signed(body) };
    expect((await app.inject({ method: "POST", url: "/webhooks/shopify", headers, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/webhooks/shopify", headers, payload: body })).statusCode).toBe(200);
    expect(await db().webhookEvent.count()).toBe(1);
    expect(await db().job.count({ where: { type: "process-webhook" } })).toBe(1);
    expect((await app.inject({ method: "POST", url: "/webhooks/shopify", headers: { ...headers, "x-shopify-webhook-id": "wh-2", "x-shopify-hmac-sha256": "falsch" }, payload: body })).statusCode).toBe(401);
    await app.close();

    // Verarbeitung lädt die Bestellung per GraphQL nach (gemockter Shopify-Endpunkt) – zweimal verarbeitet = idempotent
    const order = {
      id: "gid://shopify/Order/4242", name: "#4242", number: 4242, createdAt: "2026-12-01T09:00:00Z", updatedAt: "2026-12-02T09:00:00Z", cancelledAt: null, test: false, email: "w@example.test",
      customerLocale: "de", sourceName: "web", customerAcceptsMarketing: false, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", returnStatus: "NO_RETURN",
      totalPriceSet: { shopMoney: { amount: "50.0", currencyCode: "EUR" } }, totalRefundedSet: { shopMoney: { amount: "0.0" } }, customer: null, shippingLine: { title: "Versand", carrierIdentifier: null },
      lineItems: { nodes: [] }, fulfillments: [], customerJourneySummary: null,
    };
    const fetchImpl = (async (url: string) =>
      String(url).includes("access_token") ? Response.json({ access_token: "t", expires_in: 86399 }) : Response.json({ data: { order } })) as unknown as typeof fetch;
    setShopifyClient(new ShopifyClient("test-shop.myshopify.com", "id", "secret", "2026-10", fetchImpl));
    const evt = await db().webhookEvent.findFirstOrThrow();
    await processWebhook(evt.id);
    await processWebhook(evt.id);
    expect(await db().order.count({ where: { shopifyOrderId: "gid://shopify/Order/4242" } })).toBe(1);
    expect((await db().webhookEvent.findFirstOrThrow()).status).toBe("PROCESSED");
    setShopifyClient(undefined);
  });

  it("Abmeldelink: GET bestätigt nur, POST sperrt und stoppt Kampagnen", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "stop@example.test" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const url = mail.sent[0]!.text.match(/https:\/\/reviews\.example\.test(\/u\/\S+)/)![1]!;
    const app = await buildApp({ serveWeb: false });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect(await db().emailSuppression.count()).toBe(0);
    expect((await app.inject({ method: "POST", url, payload: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode).toBe(200);
    expect(await db().emailSuppression.count({ where: { email: "stop@example.test" } })).toBe(1);
    expect((await app.inject({ method: "GET", url: "/u/manipuliert.abc" })).statusCode).toBe(400);

    // Neue Bestellung derselben Person wird nicht mehr angeschrieben
    const id2 = await addOrder(shopId, { deliveredAt: "2026-12-10T14:00:00+01:00", email: "stop@example.test" });
    expect(await evaluateOrder(id2, new Date("2026-12-11T10:00:00Z"))).toBe("CANCELLED");
    await app.close();
  });

  it("Austragen: Link in jeder Mail, Kontakt wird danach überall ignoriert – auch nach DSGVO-Löschung", async () => {
    const order = makeOrder({ deliveredAt: "2026-12-01T14:00:00+01:00", email: "Raus@Example.test" });
    const id = await upsertOrder(shopId, order);
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const m = mail.sent[0]!;
    expect(m.text).toMatch(/Keine Bewertungsanfragen mehr\? Hier austragen: https:\/\/reviews\.example\.test\/u\//);
    expect(m.html).toContain(">Hier austragen</a>");
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/reviews\.example\.test\/u\//);

    const url = m.text.match(/https:\/\/reviews\.example\.test(\/u\/\S+)/)![1]!;
    const app = await buildApp({ serveWeb: false });
    const res = await app.inject({ method: "POST", url });
    expect(res.body).toContain("Du bist ausgetragen");

    // manuelle Erinnerung wird abgelehnt
    const c = (await campaign(id))!;
    expect(await manualReminderCheck(c.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/ausgetragen/) });
    // neue Bestellung (Groß-/Kleinschreibung egal) → ignoriert
    const id2 = await addOrder(shopId, { deliveredAt: "2026-12-10T14:00:00+01:00", email: "raus@example.test" });
    expect(await evaluateOrder(id2, new Date("2026-12-11T10:00:00Z"))).toBe("CANCELLED");

    // DSGVO-Löschung: Klartext weg, Sperre bleibt als Hash
    const owner = await login(app, shopId);
    await app.inject({ method: "POST", url: "/api/gdpr/delete", headers: { cookie: owner }, payload: { email: "raus@example.test", confirm: true } });
    expect(await db().emailSuppression.count({ where: { email: "raus@example.test" } })).toBe(0);
    expect(await db().emailSuppression.count({ where: { email: { startsWith: "sha256:" } } })).toBe(1);
    const id3 = await addOrder(shopId, { deliveredAt: "2026-12-20T14:00:00+01:00", email: "raus@example.test" });
    expect(await evaluateOrder(id3, new Date("2026-12-21T10:00:00Z"))).toBe("CANCELLED");
    expect(mail.sent).toHaveLength(1);
    await app.close();
  });

  it("Klick-Weiterleitung zählt Klicks (keine Bewertung)", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    const inv = (await invitations(id))[0]!;
    const app = await buildApp({ serveWeb: false });
    const res = await app.inject({ method: "GET", url: `/r/${inv.trackingToken}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("https://g.page/r/test/review");
    await app.inject({ method: "GET", url: `/r/${inv.trackingToken}` });
    expect((await invitations(id))[0]!.clickCount).toBe(2);
    expect(await db().reviewEvent.count({ where: { type: "LINK_CLICKED" } })).toBe(1);
    expect(await db().reviewEvent.count({ where: { type: "REVIEW_CONFIRMED" } })).toBe(0);
    await app.close();
  });

  it("Test-E-Mail nur an hinterlegte Testempfänger, nie an Kunden; Freigabe nur mit Checkliste", async () => {
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);
    await addOrder(shopId, { email: "kunde-echt@example.test" });
    await db().reviewRule.update({ where: { shopId }, data: { testRecipients: ["test@adfunture.test", "kunde-echt@example.test"], sendingEnabled: false } });
    expect((await app.inject({ method: "POST", url: "/api/test-email", headers: { cookie }, payload: { to: "fremd@example.test" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/test-email", headers: { cookie }, payload: { to: "kunde-echt@example.test" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/test-email", headers: { cookie }, payload: { to: "test@adfunture.test", step: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(mail.sent.at(-1)!.subject).toBe("[TEST] Deine Meinung zu Adfunture ist uns wichtig");
    // Test aus einem Plattform-Vorlagensatz nutzt dessen Vorlage und Bewertungslink
    await db().reviewPlatform.update({ where: { shopId_key: { shopId, key: "IDEALO" } }, data: { active: true, reviewUrl: "https://www.idealo.de/preisvergleich/ShopRatingForm/336477.html" } });
    expect((await app.inject({ method: "POST", url: "/api/test-email", headers: { cookie }, payload: { to: "test@adfunture.test", step: 1, scope: "IDEALO" } })).statusCode).toBe(200);
    expect(mail.sent.at(-1)!.subject).toContain("idealo");
    expect(mail.sent.at(-1)!.text).toContain("idealo.de/preisvergleich/ShopRatingForm/336477.html");

    // Freigabe scheitert, weil im Test kein SMTP konfiguriert ist (EMAIL_TRANSPORT=log)
    const rel = await app.inject({ method: "POST", url: "/api/settings/release", headers: { cookie }, payload: { confirmation: "VERSAND FREIGEBEN", acknowledgeJudgemeParallel: true } });
    expect(rel.statusCode).toBe(400);
    expect(rel.json().error).toContain("SMTP");
    expect((await db().reviewRule.findUniqueOrThrow({ where: { shopId } })).sendingEnabled).toBe(false);
    await app.close();
  });

  it("ohne Anmeldung kein Zugriff; Betrachter dürfen nichts ändern", async () => {
    const app = await buildApp({ serveWeb: false });
    expect((await app.inject({ method: "GET", url: "/api/dashboard" })).statusCode).toBe(401);
    const cookie = await login(app, shopId, "VIEWER");
    expect((await app.inject({ method: "GET", url: "/api/dashboard?days=30", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/settings/stop", headers: { cookie } })).statusCode).toBe(403);
    await app.close();
  });

  it("Google-Unternehmensprofil: nur echte Bewertungslinks, keine Anreize in Vorlagen", async () => {
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);
    const google = await db().reviewPlatform.findFirstOrThrow({ where: { shopId, key: "GOOGLE_BUSINESS" } });
    const put = (reviewUrl: string) =>
      app.inject({ method: "PUT", url: `/api/platforms/${google.id}`, headers: { cookie }, payload: { active: true, reviewUrl, remindersAllowed: true, priority: 10, targetShare: 100, extraDelayDays: 0, onlyForChannels: [], notes: null } });
    expect((await put("https://maps.app.goo.gl/abc123")).statusCode).toBe(400);
    expect((await put("http://g.page/r/CQabc123/review")).statusCode).toBe(400);
    expect((await put("https://g.page/r/CQabc123XYZ/review")).statusCode).toBe(200);
    expect((await put("https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4")).statusCode).toBe(200);

    const tpl = (bodyText: string) => app.inject({ method: "PUT", url: "/api/templates", headers: { cookie }, payload: { scope: "GOOGLE_BUSINESS", step: 1, subject: "Bewerte uns", bodyText } });
    expect((await tpl("Hallo, für 5 Sterne gibt es einen 10 % Gutschein! {{review_link}}")).json().error).toMatch(/Gutschein|positive/);
    expect((await tpl("Hallo, teile deine ehrliche Meinung: {{review_link}}")).statusCode).toBe(200);
    await app.close();
  });

  it("manuelle Erinnerung per API nur mit Bestätigung und nicht für Betrachter", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    await sendDueInvitations(new Date("2026-12-05T08:01:00Z"));
    const c = (await campaign(id))!;
    const app = await buildApp({ serveWeb: false });
    const viewer = await login(app, shopId, "VIEWER");
    expect((await app.inject({ method: "POST", url: `/api/campaigns/${c.id}/manual-reminder`, headers: { cookie: viewer }, payload: { confirmNoReview: true } })).statusCode).toBe(403);
    const owner = await login(app, shopId, "OWNER");
    expect((await app.inject({ method: "GET", url: `/api/campaigns/${c.id}/manual-reminder`, headers: { cookie: owner } })).json()).toMatchObject({ ok: true, step: 2 });
    expect((await app.inject({ method: "POST", url: `/api/campaigns/${c.id}/manual-reminder`, headers: { cookie: owner }, payload: {} })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: `/api/campaigns/${c.id}/manual-reminder`, headers: { cookie: owner }, payload: { confirmNoReview: true } });
    expect(ok.statusCode).toBe(200);
    expect(await db().auditLog.count({ where: { action: "campaign.manual_reminder" } })).toBe(1);
    await app.close();
  });

  it("Dashboard zeigt echte Kennzahlen, nicht verfügbare Werte als null", async () => {
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);
    const res = await app.inject({ method: "GET", url: "/api/dashboard?days=30", headers: { cookie } });
    const body = res.json();
    expect(body.stats.orders).toBe(0);
    expect(body.stats.clickRate).toBeNull();
    expect(body.stats.averageRating).toBeNull();
    const ps = (await app.inject({ method: "GET", url: "/api/platform-stats?days=30", headers: { cookie } })).json();
    expect(ps.find((p: { key: string }) => p.key === "GOOGLE_BUSINESS").confirmedReviews).toBeNull();
    await app.close();
  });

  it("DSGVO: Export und Löschung", async () => {
    const id = await addOrder(shopId, { deliveredAt: "2026-12-01T14:00:00+01:00", email: "dsgvo@example.test" });
    await evaluateOrder(id, new Date("2026-12-02T10:00:00Z"));
    const app = await buildApp({ serveWeb: false });
    const cookie = await login(app, shopId);
    const exp = await app.inject({ method: "GET", url: "/api/gdpr/export?email=dsgvo@example.test", headers: { cookie } });
    expect(exp.json().orders).toHaveLength(1);
    const del = await app.inject({ method: "POST", url: "/api/gdpr/delete", headers: { cookie }, payload: { email: "dsgvo@example.test", confirm: true } });
    expect(del.json().orders).toBe(1);
    const o = await db().order.findUniqueOrThrow({ where: { id } });
    expect(o.email).toBeNull();
    expect((await campaign(id))?.status).toBe("CANCELLED");
    await app.close();
  });
});
