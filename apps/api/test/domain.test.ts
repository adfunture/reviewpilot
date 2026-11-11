import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { detectChannel } from "../src/domain/attribution.js";
import { deriveDelivery, type FulfillmentInput } from "../src/domain/delivery.js";
import { planCampaign, resolveSendTime, selectPlatform, stepDates, type PlanInput, type PlatformOption, type RuleSettings } from "../src/domain/planner.js";
import { reminderDecision } from "../src/domain/reminders.js";
import { formatDateDe, intoSendWindow } from "../src/domain/time.js";
import { DEFAULT_TEMPLATES, findUnknownPlaceholders, GOOGLE_BUSINESS_TEMPLATES, IDEALO_TEMPLATES, renderEmail } from "../src/email/render.js";
import { reviewUrlProblem, templatePolicyProblems } from "../src/domain/platformLinks.js";
import { normalizeOrder } from "../src/shopify/mapper.js";
import { orderGidFromWebhook, verifyShopifyHmac } from "../src/shopify/webhooks.js";

const TZ = "Europe/Berlin";
const S: RuleSettings = {
  firstRequestDaysAfterDelivery: 4,
  fallbackDaysAfterOrder: 14,
  reminderIntervalDays: 3,
  maxAttempts: 3,
  sendWindowStartHour: 9,
  sendWindowEndHour: 19,
  timezone: TZ,
  legalBasis: "UWG_7_3",
};
const GOOGLE: PlatformOption = { id: "p-google", key: "GOOGLE_BUSINESS", active: true, integrationType: "LINK", reviewUrl: "https://g.page/r/x/review", priority: 10, targetShare: 50, extraDelayDays: 0, onlyForChannels: [] };
const IDEALO: PlatformOption = { id: "p-idealo", key: "IDEALO", active: true, integrationType: "LINK", reviewUrl: "https://example.test/idealo", priority: 20, targetShare: 30, extraDelayDays: 0, onlyForChannels: ["IDEALO"] };

const base: PlanInput = {
  orderId: "order-1",
  orderCreatedAt: new Date("2026-12-01T10:00:00+01:00"),
  isTest: false,
  email: "kunde@example.test",
  cancelledAt: null,
  totalPrice: 100,
  totalRefunded: 0,
  deliveryStatus: "DELIVERED",
  deliveredAt: new Date("2026-12-01T14:00:00+01:00"),
  fullyShipped: true,
  shippedAt: new Date("2026-12-01T12:00:00+01:00"),
  hasTracking: true,
  isFreight: false,
  channel: "GOOGLE_SHOPPING",
  reviewBlocked: false,
  suppressed: false,
  consent: "NONE",
};

const days = (dates: Date[]) => dates.map((d) => formatDateDe(d, TZ));

describe("Versandregeln (Kapitel 6)", () => {
  it("Variante A: Zustellung 01.12. → 05.12., 08.12., 11.12. um 9 Uhr", () => {
    const dates = stepDates("TRACKED", new Date("2026-12-01T14:00:00+01:00"), S);
    expect(days(dates)).toEqual(["05.12.2026", "08.12.2026", "11.12.2026"]);
    expect(dates[0]!.toISOString()).toBe("2026-12-05T08:00:00.000Z");
  });

  it("Variante B: Bestellung 01.12. → 15.12., 18.12., 21.12.", () => {
    expect(days(stepDates("UNTRACKED_FALLBACK", new Date("2026-12-01T23:30:00+01:00"), S))).toEqual(["15.12.2026", "18.12.2026", "21.12.2026"]);
  });

  it("rechnet Kalendertage in Berliner Zeit über die Zeitumstellung", () => {
    const d = stepDates("TRACKED", new Date("2026-03-27T12:00:00+01:00"), S)[0]!; // Umstellung am 29.03.
    expect(formatDateDe(d, TZ)).toBe("31.03.2026");
    expect(d.toISOString()).toBe("2026-03-31T07:00:00.000Z"); // 9 Uhr MESZ
  });

  it("konfigurierbare Verzögerung 3–5 Tage", () => {
    expect(days(stepDates("TRACKED", new Date("2026-12-01T12:00:00+01:00"), { ...S, firstRequestDaysAfterDelivery: 3 }))[0]).toBe("04.12.2026");
  });

  it("Versandfenster: abends geplante Zeit → nächster Morgen", () => {
    const at = intoSendWindow(new Date("2026-12-05T20:30:00+01:00"), 9, 19, TZ);
    expect(at.toISOString()).toBe("2026-12-06T08:00:00.000Z");
  });

  it("keine rückwirkende Massenversendung: >48 h verpasst", () => {
    const planned = new Date("2026-12-05T08:00:00Z");
    expect(resolveSendTime(planned, new Date("2026-12-06T10:00:00Z"), S)).toEqual({ at: new Date("2026-12-06T10:00:00Z") });
    expect(resolveSendTime(planned, new Date("2026-12-08T10:00:00Z"), S)).toEqual({ missed: true });
  });
});

describe("Kampagnenplanung", () => {
  it("ohne Rechtsgrundlage → CONSENT_MISSING", () => {
    expect(planCampaign(base, { ...S, legalBasis: "NONE" }, [GOOGLE])).toMatchObject({ kind: "terminal", status: "CONSENT_MISSING" });
  });
  it("Einwilligungsmodell ohne Einwilligung → CONSENT_MISSING", () => {
    expect(planCampaign(base, { ...S, legalBasis: "CONSENT" }, [GOOGLE])).toMatchObject({ status: "CONSENT_MISSING" });
    expect(planCampaign({ ...base, consent: "GRANTED" }, { ...S, legalBasis: "CONSENT" }, [GOOGLE])).toMatchObject({ kind: "schedule" });
  });
  it("Widerspruch stoppt auch bei § 7 Abs. 3 UWG", () => {
    expect(planCampaign({ ...base, consent: "OBJECTED" }, S, [GOOGLE])).toMatchObject({ status: "CONSENT_MISSING" });
  });
  it("Storno, Vollerstattung, Retoure, Testbestellung → CANCELLED", () => {
    expect(planCampaign({ ...base, cancelledAt: new Date() }, S, [GOOGLE])).toMatchObject({ status: "CANCELLED" });
    expect(planCampaign({ ...base, totalRefunded: 100 }, S, [GOOGLE])).toMatchObject({ status: "CANCELLED", reason: "Vollständig erstattet" });
    expect(planCampaign({ ...base, totalRefunded: 30 }, S, [GOOGLE])).toMatchObject({ kind: "schedule" }); // Teilerstattung
    expect(planCampaign({ ...base, deliveryStatus: "RETURNED" }, S, [GOOGLE])).toMatchObject({ status: "CANCELLED" });
    expect(planCampaign({ ...base, isTest: true }, S, [GOOGLE])).toMatchObject({ status: "CANCELLED" });
  });
  it("jede Bestellung: Erstattung/Retoure wird angefragt, wenn eingeschaltet; Storno nie", () => {
    const all = { ...S, includeRefundedOrders: true };
    expect(planCampaign({ ...base, totalRefunded: 100 }, all, [GOOGLE])).toMatchObject({ kind: "schedule", rule: "TRACKED" });
    expect(planCampaign({ ...base, deliveryStatus: "RETURNED", deliveredAt: null }, all, [GOOGLE])).toMatchObject({ kind: "schedule", rule: "UNTRACKED_FALLBACK" });
    expect(planCampaign({ ...base, cancelledAt: new Date() }, all, [GOOGLE])).toMatchObject({ status: "CANCELLED" });
    expect(planCampaign({ ...base, deliveryStatus: "PROCESSING", deliveredAt: null, fullyShipped: false, shippedAt: null }, all, [GOOGLE])).toMatchObject({ kind: "wait" });
  });
  it("Lieferverzögerung/-fehler pausiert nur", () => {
    expect(planCampaign({ ...base, deliveryStatus: "DELAYED", deliveredAt: null }, S, [GOOGLE])).toMatchObject({ kind: "wait", status: "PAUSED" });
    expect(planCampaign({ ...base, deliveryStatus: "FAILED", deliveredAt: null }, S, [GOOGLE])).toMatchObject({ kind: "wait", status: "PAUSED" });
  });
  it("nicht versendet → wartet", () => {
    expect(planCampaign({ ...base, deliveryStatus: "PROCESSING", deliveredAt: null, fullyShipped: false }, S, [GOOGLE])).toMatchObject({ kind: "wait", status: "PENDING" });
  });
  it("Spedition ohne Tracking → Variante B ab Bestelldatum", () => {
    const r = planCampaign({ ...base, deliveryStatus: "DELIVERY_UNKNOWN", deliveredAt: null, hasTracking: false, isFreight: true }, S, [GOOGLE]);
    expect(r).toMatchObject({ kind: "schedule", rule: "UNTRACKED_FALLBACK" });
    if (r.kind === "schedule") expect(days(r.dates)[0]).toBe("15.12.2026");
  });
  it("verspäteter Versand ohne Tracking: frühestens 7 Tage nach Versand", () => {
    const r = planCampaign({ ...base, deliveryStatus: "DELIVERY_UNKNOWN", deliveredAt: null, shippedAt: new Date("2026-12-20T10:00:00+01:00") }, S, [GOOGLE]);
    if (r.kind !== "schedule") throw new Error("erwartet schedule");
    expect(days(r.dates)[0]).toBe("27.12.2026");
  });
  it("Tracking ohne Zustellbestätigung (unterwegs) → Variante B, nie als zugestellt", () => {
    expect(planCampaign({ ...base, deliveryStatus: "IN_TRANSIT", deliveredAt: null }, S, [GOOGLE])).toMatchObject({ rule: "UNTRACKED_FALLBACK" });
  });
  it("keine aktive Plattform → wartet (kein Versand)", () => {
    expect(planCampaign(base, S, [{ ...GOOGLE, active: false }])).toMatchObject({ kind: "wait", status: "PENDING" });
    expect(planCampaign(base, S, [{ ...GOOGLE, reviewUrl: null }])).toMatchObject({ kind: "wait" });
  });
});

describe("Plattformwahl", () => {
  it("idealo nur für idealo-Bestellungen", () => {
    expect(selectPlatform("x", "GOOGLE_SHOPPING", [IDEALO])).toBeNull();
    expect(selectPlatform("x", "IDEALO", [IDEALO])?.key).toBe("IDEALO");
  });
  it("idealo-Bestellung → idealo hat Vorrang vor Google; andere Bestellungen → Google", () => {
    for (let i = 0; i < 50; i++) expect(selectPlatform(`order-${i}`, "IDEALO", [GOOGLE, IDEALO])?.key).toBe("IDEALO");
    expect(selectPlatform("x", "GOOGLE_SHOPPING", [GOOGLE, IDEALO])?.key).toBe("GOOGLE_BUSINESS");
    expect(selectPlatform("x", "IDEALO", [GOOGLE, { ...IDEALO, active: false }])?.key).toBe("GOOGLE_BUSINESS");
  });
  it("deterministisch und gewichtet (≈ Zielanteile) unter allgemeinen Plattformen", () => {
    const TP: PlatformOption = { ...GOOGLE, id: "p-tp", key: "TRUSTPILOT", targetShare: 30, priority: 40 };
    const counts = { GOOGLE_BUSINESS: 0, TRUSTPILOT: 0 } as Record<string, number>;
    for (let i = 0; i < 4000; i++) counts[selectPlatform(`order-${i}`, "DIRECT", [GOOGLE, TP])!.key]!++;
    expect(counts.GOOGLE_BUSINESS! / 4000).toBeGreaterThan(0.57);
    expect(counts.GOOGLE_BUSINESS! / 4000).toBeLessThan(0.68); // 50/(50+30) = 62,5 %
    expect(selectPlatform("order-7", "DIRECT", [GOOGLE, TP])).toEqual(selectPlatform("order-7", "DIRECT", [GOOGLE, TP]));
  });
  it("Plattformen, die selbst versenden, werden nie für eigene E-Mails gewählt", () => {
    expect(selectPlatform("x", "UNKNOWN", [{ ...GOOGLE, integrationType: "EXTERNAL_PROGRAM" }])).toBeNull();
  });
});

describe("Erinnerungen", () => {
  const ctx = { step: 2, reviewStatus: "UNKNOWN" as const, platformRemindersAllowed: true, platformStatusQueryAvailable: false, remindersOnUnknownStatus: false };
  it("unbekannter Status → standardmäßig keine Erinnerung", () => {
    expect(reminderDecision(ctx)).toMatchObject({ allowed: false, unknown: true });
  });
  it("nur bei ausdrücklicher Freischaltung", () => {
    expect(reminderDecision({ ...ctx, remindersOnUnknownStatus: true })).toEqual({ allowed: true });
  });
  it("nachweislich nicht bewertet → erlaubt; bewertet → nie", () => {
    expect(reminderDecision({ ...ctx, reviewStatus: "NOT_REVIEWED", platformStatusQueryAvailable: true })).toEqual({ allowed: true });
    expect(reminderDecision({ ...ctx, reviewStatus: "REVIEWED", remindersOnUnknownStatus: true })).toMatchObject({ allowed: false });
  });
  it("Plattform verbietet Erinnerungen", () => {
    expect(reminderDecision({ ...ctx, platformRemindersAllowed: false, remindersOnUnknownStatus: true })).toMatchObject({ allowed: false });
  });
});

describe("Zustellstatus (Kapitel 7)", () => {
  const f = (o: Partial<FulfillmentInput>): FulfillmentInput => ({ status: "SUCCESS", displayStatus: "FULFILLED", carrier: "DHL", trackingNumber: "00340434", shippedAt: new Date("2026-12-01"), events: [], ...o });
  const P = ["spedition", "dachser"];

  it("Versand ist keine Zustellung", () => {
    expect(deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({})] }, P).status).toBe("SHIPPED");
  });
  it("DHL zugestellt (Shopify deliveredAt)", () => {
    const r = deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({ displayStatus: "DELIVERED", deliveredAt: new Date("2026-12-03T10:00:00Z") })] }, P);
    expect(r).toMatchObject({ status: "DELIVERED", source: "SHOPIFY" });
  });
  it("GLS unterwegs", () => {
    const r = deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({ carrier: "GLS", displayStatus: "IN_TRANSIT", events: [{ status: "IN_TRANSIT", happenedAt: new Date(), source: "SHOPIFY" }] })] }, P);
    expect(r.status).toBe("IN_TRANSIT");
  });
  it("Spedition ohne Tracking → Zustellung unbekannt", () => {
    const r = deriveDelivery({ fulfillmentStatus: "FULFILLED", shippingMethod: "Speditionsversand", fulfillments: [f({ carrier: null, trackingNumber: null })] }, P);
    expect(r).toMatchObject({ status: "DELIVERY_UNKNOWN", isFreight: true, hasTracking: false });
  });
  it("manuelle Zustellbestätigung", () => {
    const r = deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({ trackingNumber: null, events: [{ status: "DELIVERED", happenedAt: new Date("2026-12-04"), source: "MANUAL" }] })] }, P);
    expect(r).toMatchObject({ status: "DELIVERED", source: "MANUAL" });
  });
  it("Teillieferung ist nicht vollständig zugestellt", () => {
    const r = deriveDelivery({ fulfillmentStatus: "PARTIALLY_FULFILLED", fulfillments: [f({ deliveredAt: new Date() })] }, P);
    expect(r.status).not.toBe("DELIVERED");
    expect(r.fullyShipped).toBe(false);
  });
  it("verzögert, fehlgeschlagen, storniert, Retoure, ohne Fulfillment", () => {
    expect(deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({ displayStatus: "DELAYED" })] }, P).status).toBe("DELAYED");
    expect(deriveDelivery({ fulfillmentStatus: "FULFILLED", fulfillments: [f({ displayStatus: "FAILURE" })] }, P).status).toBe("FAILED");
    expect(deriveDelivery({ cancelledAt: new Date(), fulfillments: [] }, P).status).toBe("CANCELLED");
    expect(deriveDelivery({ returnStatus: "RETURNED", fulfillmentStatus: "FULFILLED", fulfillments: [f({})] }, P).status).toBe("RETURNED");
    expect(deriveDelivery({ fulfillmentStatus: "UNFULFILLED", fulfillments: [] }, P).status).toBe("PROCESSING");
  });
});

describe("Kanalerkennung (Kapitel 5)", () => {
  it("UTM idealo / geizhals / billiger", () => {
    expect(detectChannel({ utmSource: "idealo", utmMedium: "cpc" })).toMatchObject({ channel: "IDEALO", method: "utm_source", confidence: "HIGH" });
    expect(detectChannel({ utmSource: "Geizhals" }).channel).toBe("GEIZHALS");
    expect(detectChannel({ landingPage: "https://adfunture.de/p?utm_source=billiger" }).channel).toBe("BILLIGER");
  });
  it("Google: Shopping (product_sync), Ads (cpc), organisch (Referrer)", () => {
    expect(detectChannel({ utmSource: "google", utmMedium: "product_sync" }).channel).toBe("GOOGLE_SHOPPING");
    expect(detectChannel({ utmSource: "google", utmMedium: "cpc" }).channel).toBe("GOOGLE_ADS");
    expect(detectChannel({ referrerUrl: "https://www.google.com/" })).toMatchObject({ channel: "GOOGLE_ORGANIC", confidence: "MEDIUM" });
  });
  it("cpc ohne Google-Quelle ist kein Google Ads", () => {
    expect(detectChannel({ utmSource: "partnerx", utmMedium: "cpc" }).channel).toBe("OTHER");
  });
  it("keine Daten → Unbekannt (nichts erfinden)", () => {
    expect(detectChannel({})).toEqual({ channel: "UNKNOWN", method: "none", confidence: "NONE" });
    expect(detectChannel({ sourceName: "web" }).channel).toBe("UNKNOWN");
  });
});

describe("E-Mail-Vorlagen", () => {
  const footer = { unsubscribeUrl: "https://x.test/u/abc", legalBasisNotice: "Widerspruch jederzeit möglich.", imprint: "Adfunture" };
  it("ersetzt Platzhalter und enthält Pflichtangaben", () => {
    const m = renderEmail(DEFAULT_TEMPLATES[0]!.subject, DEFAULT_TEMPLATES[0]!.body, { first_name: "Anna", review_link: "https://x.test/r/1", order_name: "#1", shop_name: "Adfunture" }, footer);
    expect(m.text).toContain("Hallo Anna,");
    expect(m.text).toContain("https://x.test/r/1");
    expect(m.text).toContain("Hier austragen: https://x.test/u/abc");
    expect(m.html).toContain('href="https://x.test/r/1"');
    expect(m.html).toContain("Widerspruch jederzeit möglich.");
  });
  it("ohne Vorname: „Hallo,“", () => {
    const m = renderEmail("Betreff", "Hallo {{first_name}},\n\n{{review_link}}", { first_name: null, review_link: "https://x.test/r/1", order_name: "#1", shop_name: "A" }, footer);
    expect(m.text.startsWith("Hallo,")).toBe(true);
  });
  it("escaped HTML in Kundendaten", () => {
    const m = renderEmail("B", "Hallo {{first_name}}\n\n{{review_link}}", { first_name: "<script>", review_link: "https://x.test/r/1", order_name: "#1", shop_name: "A" }, footer);
    expect(m.html).not.toContain("<script>");
  });
  it("erkennt unbekannte Platzhalter", () => {
    expect(findUnknownPlaceholders("{{first_name}} {{rabatt}}")).toEqual(["rabatt"]);
  });
});

describe("Google-Unternehmensprofil", () => {
  it("akzeptiert nur Bewertungsformular-Links", () => {
    expect(reviewUrlProblem("GOOGLE_BUSINESS", "https://g.page/r/CQabc-_123/review")).toBeNull();
    expect(reviewUrlProblem("GOOGLE_BUSINESS", "https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4")).toBeNull();
    expect(reviewUrlProblem("GOOGLE_BUSINESS", "https://maps.app.goo.gl/xyz")).toMatch(/Kein Google-Bewertungslink/);
    expect(reviewUrlProblem("GOOGLE_BUSINESS", "https://www.google.com/maps/place/Adfunture")).not.toBeNull();
    expect(reviewUrlProblem("GOOGLE_BUSINESS", "https://search.google.com/local/writereview?placeid=")).not.toBeNull();
    expect(reviewUrlProblem("IDEALO", "https://www.idealo.de/preisvergleich/ShopRatingForm/336477.html")).toBeNull();
    expect(reviewUrlProblem("IDEALO", "https://www.idealo.de/preisvergleich/Shop/336477.html")).toMatch(/Kein idealo-Bewertungslink/);
  });
  it("Standard- und Google-Vorlagen enthalten keine Anreize oder Einflussnahme", () => {
    for (const t of [...DEFAULT_TEMPLATES, ...GOOGLE_BUSINESS_TEMPLATES, ...IDEALO_TEMPLATES]) {
      expect(templatePolicyProblems(`${t.subject}
${t.body}`)).toEqual([]);
      expect(findUnknownPlaceholders(t.body)).toEqual([]);
      expect(t.body).toContain("{{review_link}}");
    }
  });
  it("erkennt unzulässige Formulierungen", () => {
    expect(templatePolicyProblems("Für eine 5-Sterne-Bewertung erhältst du einen Gutschein")).toHaveLength(2);
    expect(templatePolicyProblems("Mach mit beim Gewinnspiel")).toHaveLength(1);
  });
});

describe("Shopify", () => {
  it("prüft Webhook-HMAC", () => {
    const body = Buffer.from('{"id":1}');
    const sig = createHmac("sha256", "geheim").update(body).digest("base64");
    expect(verifyShopifyHmac(body, sig, "geheim")).toBe(true);
    expect(verifyShopifyHmac(body, sig, "falsch")).toBe(false);
    expect(verifyShopifyHmac(Buffer.from('{"id":2}'), sig, "geheim")).toBe(false);
    expect(verifyShopifyHmac(body, undefined, "geheim")).toBe(false);
  });
  it("ermittelt Bestell-ID aus Webhooks", () => {
    expect(orderGidFromWebhook("orders/updated", { admin_graphql_api_id: "gid://shopify/Order/5" })).toBe("gid://shopify/Order/5");
    expect(orderGidFromWebhook("fulfillment_events/create", { order_id: 7 })).toBe("gid://shopify/Order/7");
    expect(orderGidFromWebhook("products/update", { id: 1 })).toBeNull();
  });
  it("liest die Deutsche-Post-Sendungsnummer aus der Tracking-URL", () => {
    const o = normalizeOrder({
      id: "gid://shopify/Order/1", name: "#1", number: 1, createdAt: "2026-11-10T08:00:00Z", updatedAt: "2026-11-11T08:00:00Z", cancelledAt: null, test: false, email: "A@B.de",
      customerLocale: "de-DE", sourceName: "web", customerAcceptsMarketing: false, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", returnStatus: "NO_RETURN",
      totalPriceSet: { shopMoney: { amount: "12.9", currencyCode: "EUR" } }, totalRefundedSet: { shopMoney: { amount: "0.0" } }, customer: null, shippingLine: { title: "Versand", carrierIdentifier: null },
      lineItems: { nodes: [] },
      fulfillments: [{ id: "f1", status: "SUCCESS", displayStatus: "IN_TRANSIT", createdAt: "2026-11-11T08:31:40Z", inTransitAt: null, deliveredAt: null, estimatedDeliveryAt: null,
        trackingInfo: [{ company: "dpag", number: null, url: "https://www.deutschepost.de/sendung/simpleQueryResult.html?form.sendungsnummer=A005D1F9&form.einlieferungsdatum_tag=11" }], events: { nodes: [] } }],
      customerJourneySummary: { ready: true, firstVisit: null, lastVisit: { source: "Google", referrerUrl: "https://www.google.com/", landingPage: "https://adfunture.de/p", utmParameters: { source: "idealo", medium: "cpc", campaign: null } } },
    });
    expect(o.fulfillments[0]!.trackingNumber).toBe("A005D1F9");
    expect(o.email).toBe("a@b.de");
    expect(o.attribution.utmSource).toBe("idealo");
  });
});
