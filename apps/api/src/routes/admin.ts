import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { cancelCampaign, evaluateOrder, manualReminderCheck, markReviewReceived, pauseCampaign, resumeCampaign, scheduleManualReminder } from "../campaigns/engine.js";
import { clickUrl, legalNotice, sendingBlockedReason, unsubscribeUrl } from "../campaigns/sender.js";
import { config, shopifyConfigured } from "../config.js";
import { findUnknownPlaceholders, renderEmail } from "../email/render.js";
import { reviewUrlProblem, templatePolicyProblems } from "../domain/platformLinks.js";
import { emailTransport } from "../email/transport.js";
import { audit, db } from "../lib/db.js";
import { enqueue } from "../jobs/queue.js";
import { JUDGEME_CAPABILITIES, saveJudgemeConfig, testJudgeme } from "../platforms/judgeme.js";
import { exportPersonalData, deletePersonalData } from "../services/gdpr.js";
import { ShopifyClient } from "../shopify/client.js";
import { SHOP_INFO, WEBHOOK_CREATE, WEBHOOK_SUBSCRIPTIONS, WEBHOOK_TOPICS } from "../shopify/queries.js";
import { recomputeDelivery } from "../shopify/sync.js";
import { authenticate, requireWrite } from "./auth.js";
import { dailySeries, dashboardStats, platformStats } from "./stats.js";

const SALES_CHANNELS = ["IDEALO", "GOOGLE_SHOPPING", "GOOGLE_ADS", "GOOGLE_ORGANIC", "GEIZHALS", "BILLIGER", "DIRECT", "EMAIL", "SOCIAL", "OTHER", "UNKNOWN"] as const;
const RELEASE_PHRASE = "VERSAND FREIGEBEN";

function rangeFrom(q: { from?: string; to?: string; days?: string }) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - Number(q.days ?? 30) * 86400_000);
  return { from, to };
}
const actor = (req: FastifyRequest) => `user:${req.user!.id}`;
const shopId = (req: FastifyRequest) => req.user!.shopId;

/** Lädt eine Kampagne nur innerhalb des eigenen Mandanten */
async function ownCampaign(req: FastifyRequest, id: string) {
  const c = await db().reviewCampaign.findFirst({ where: { id, shopId: shopId(req) } });
  if (!c) throw Object.assign(new Error("Kampagne nicht gefunden"), { statusCode: 404 });
  return c;
}
async function ownOrder(req: FastifyRequest, id: string) {
  const o = await db().order.findFirst({ where: { id, shopId: shopId(req) } });
  if (!o) throw Object.assign(new Error("Bestellung nicht gefunden"), { statusCode: 404 });
  return o;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);
  const write = { preHandler: requireWrite };

  app.get("/api/me", async (req) => {
    const shop = await db().shop.findUniqueOrThrow({ where: { id: shopId(req) } });
    return { user: req.user, shop: { id: shop.id, name: shop.name, domain: shop.shopifyDomain, timezone: shop.timezone } };
  });

  // ─── Dashboard ───
  app.get("/api/dashboard", async (req) => {
    const r = rangeFrom(req.query as Record<string, string>);
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shopId(req) } });
    return {
      range: r,
      stats: await dashboardStats(shopId(req), r),
      series: await dailySeries(shopId(req), r),
      sending: { enabled: rule.sendingEnabled, blockedReason: sendingBlockedReason(rule), transport: config().EMAIL_TRANSPORT, legalBasis: rule.legalBasis },
    };
  });
  app.get("/api/platform-stats", async (req) => platformStats(shopId(req), rangeFrom(req.query as Record<string, string>)));

  // ─── Bestellungen ───
  app.get("/api/orders", async (req) => {
    const q = z
      .object({ page: z.coerce.number().int().min(1).default(1), search: z.string().optional(), campaignStatus: z.string().optional(), deliveryStatus: z.string().optional() })
      .parse(req.query);
    const where: Prisma.OrderWhereInput = { shopId: shopId(req) };
    if (q.search) where.OR = [{ name: { contains: q.search, mode: "insensitive" } }, { email: { contains: q.search.toLowerCase() } }, { lastName: { contains: q.search, mode: "insensitive" } }];
    if (q.deliveryStatus) where.deliveryStatus = q.deliveryStatus as Prisma.EnumDeliveryStatusFilter["equals"];
    if (q.campaignStatus) where.campaign = { status: q.campaignStatus as Prisma.EnumCampaignStatusFilter["equals"] };
    const pageSize = 50;
    const [total, rows] = await Promise.all([
      db().order.count({ where }),
      db().order.findMany({
        where,
        orderBy: { orderCreatedAt: "desc" },
        skip: (q.page - 1) * pageSize,
        take: pageSize,
        include: { campaign: { include: { platform: { select: { name: true } }, invitations: { orderBy: { step: "asc" } } } } },
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize,
      rows: rows.map((o) => ({
        id: o.id,
        name: o.name,
        customer: [o.firstName, o.lastName].filter(Boolean).join(" ") || null,
        orderCreatedAt: o.orderCreatedAt,
        carrier: o.carrier,
        isFreight: o.isFreight,
        hasTracking: o.hasTracking,
        deliveryStatus: o.deliveryStatus,
        deliveredAt: o.deliveredAt,
        channel: o.channel,
        shippingRule: o.campaign?.shippingRule ?? null,
        platform: o.campaign?.platform?.name ?? null,
        invitations: [1, 2, 3].map((step) => {
          const i = o.campaign?.invitations.find((x) => x.step === step);
          return i ? { status: i.status, scheduledAt: i.scheduledAt, sentAt: i.sentAt } : null;
        }),
        reviewStatus: o.campaign?.reviewStatus ?? null,
        campaignId: o.campaign?.id ?? null,
        campaignStatus: o.campaign?.status ?? null,
        campaignReason: o.campaign?.statusReason ?? null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req) => {
    await ownOrder(req, req.params.id);
    return db().order.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        items: true,
        attribution: true,
        fulfillments: { include: { trackingEvents: { orderBy: { happenedAt: "asc" } } } },
        campaign: { include: { platform: true, invitations: { orderBy: { step: "asc" }, include: { emailEvents: { orderBy: { occurredAt: "asc" } } } } } },
        reviewEvents: { orderBy: { occurredAt: "asc" } },
      },
    });
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/confirm-delivery", write, async (req) => {
    const order = await ownOrder(req, req.params.id);
    const body = z.object({ deliveredAt: z.coerce.date() }).parse(req.body);
    if (body.deliveredAt > new Date()) throw Object.assign(new Error("Zustelldatum liegt in der Zukunft"), { statusCode: 400 });
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: order.shopId } });
    await db().$transaction(async (tx) => {
      const fulfillments = await tx.fulfillment.findMany({ where: { orderId: order.id, status: "SUCCESS" } });
      if (!fulfillments.length) throw Object.assign(new Error("Bestellung ist nicht versendet"), { statusCode: 400 });
      for (const f of fulfillments) {
        await tx.trackingEvent.create({ data: { fulfillmentId: f.id, externalId: `manual:${Date.now()}:${f.id}`, source: "MANUAL", status: "DELIVERED", happenedAt: body.deliveredAt, message: `Manuell bestätigt von ${req.user!.email}` } });
      }
      await recomputeDelivery(tx, order.id, rule.freightPatterns);
    });
    await audit(order.shopId, actor(req), "order.confirm_delivery", "order", order.id, { deliveredAt: body.deliveredAt });
    return { campaignStatus: await evaluateOrder(order.id) };
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/block", write, async (req) => {
    const order = await ownOrder(req, req.params.id);
    const body = z.object({ reason: z.string().min(3) }).parse(req.body);
    await db().order.update({ where: { id: order.id }, data: { reviewBlocked: true, reviewBlockedReason: body.reason } });
    await audit(order.shopId, actor(req), "order.block", "order", order.id, body);
    return { campaignStatus: await evaluateOrder(order.id) };
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/mark-reviewed", write, async (req) => {
    const order = await ownOrder(req, req.params.id);
    const body = z.object({ rating: z.number().int().min(1).max(5).optional(), platformId: z.string().uuid().optional() }).parse(req.body ?? {});
    const campaign = await db().reviewCampaign.findUnique({ where: { orderId: order.id } });
    await db().reviewEvent.create({
      data: { shopId: order.shopId, orderId: order.id, campaignId: campaign?.id, platformId: body.platformId ?? campaign?.platformId, type: "REVIEW_MARKED_MANUALLY", rating: body.rating, occurredAt: new Date() },
    });
    if (campaign) await markReviewReceived(campaign.id, "Bewertung manuell bestätigt");
    await audit(order.shopId, actor(req), "order.mark_reviewed", "order", order.id, body);
    return { ok: true };
  });

  // ─── Kampagnen ───
  app.post<{ Params: { id: string } }>("/api/campaigns/:id/pause", write, async (req) => {
    await ownCampaign(req, req.params.id);
    await pauseCampaign(req.params.id, actor(req));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/campaigns/:id/resume", write, async (req) => {
    await ownCampaign(req, req.params.id);
    return { status: await resumeCampaign(req.params.id, actor(req)) };
  });
  app.post<{ Params: { id: string } }>("/api/campaigns/:id/cancel", write, async (req) => {
    await ownCampaign(req, req.params.id);
    await cancelCampaign(req.params.id, actor(req));
    return { ok: true };
  });

  // Manuelle Erinnerung: nur nach bewusster Prüfung, dass (noch) keine Bewertung vorliegt
  app.get<{ Params: { id: string } }>("/api/campaigns/:id/manual-reminder", async (req) => {
    await ownCampaign(req, req.params.id);
    return manualReminderCheck(req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/campaigns/:id/manual-reminder", write, async (req) => {
    await ownCampaign(req, req.params.id);
    z.object({ confirmNoReview: z.literal(true, { message: "Bitte bestätigen, dass keine Bewertung vorliegt" }) }).parse(req.body ?? {});
    return scheduleManualReminder(req.params.id, actor(req));
  });

  app.post<{ Params: { id: string } }>("/api/invitations/:id/reschedule", write, async (req) => {
    const inv = await db().reviewInvitation.findFirst({ where: { id: req.params.id, campaign: { shopId: shopId(req) } } });
    if (!inv) throw Object.assign(new Error("Einladung nicht gefunden"), { statusCode: 404 });
    if (inv.status !== "SCHEDULED") throw Object.assign(new Error("Nur geplante Einladungen können verschoben werden"), { statusCode: 400 });
    const body = z.object({ scheduledAt: z.coerce.date() }).parse(req.body);
    if (body.scheduledAt < new Date()) throw Object.assign(new Error("Zeitpunkt liegt in der Vergangenheit"), { statusCode: 400 });
    await db().reviewInvitation.update({ where: { id: inv.id }, data: { scheduledAt: body.scheduledAt, statusReason: "Manuell verschoben" } });
    await audit(shopId(req), actor(req), "invitation.reschedule", "review_invitation", inv.id, body);
    return { ok: true };
  });

  // Test-E-Mail: NUR an hinterlegte Testempfänger, niemals an Kunden
  app.post("/api/test-email", write, async (req) => {
    const body = z.object({ to: z.string().email(), step: z.number().int().min(1).max(3).default(1), platformId: z.string().uuid().optional() }).parse(req.body);
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shopId(req) } });
    const to = body.to.toLowerCase();
    if (!rule.testRecipients.map((x) => x.toLowerCase()).includes(to)) {
      throw Object.assign(new Error("Empfänger ist nicht als Testempfänger hinterlegt (Einstellungen → Testempfänger)"), { statusCode: 400 });
    }
    if ((await db().order.count({ where: { shopId: shopId(req), email: to } })) > 0) {
      throw Object.assign(new Error("Diese Adresse gehört zu einer Kundenbestellung – Testversand nicht erlaubt"), { statusCode: 400 });
    }
    const shop = await db().shop.findUniqueOrThrow({ where: { id: shopId(req) } });
    const platform = body.platformId ? await db().reviewPlatform.findFirst({ where: { id: body.platformId, shopId: shop.id } }) : null;
    const tpl =
      (platform && (await db().emailTemplate.findUnique({ where: { shopId_scope_step: { shopId: shop.id, scope: platform.key, step: body.step } } }))) ||
      (await db().emailTemplate.findUniqueOrThrow({ where: { shopId_scope_step: { shopId: shop.id, scope: "default", step: body.step } } }));
    const mail = renderEmail(
      `[TEST] ${tpl.subject}`,
      tpl.bodyText,
      { first_name: "Max", review_link: platform?.reviewUrl ?? `${config().PUBLIC_BASE_URL}/r/test`, order_name: "#TEST", shop_name: shop.name },
      { unsubscribeUrl: unsubscribeUrl(shop.id, to), legalBasisNotice: legalNotice(rule.legalBasis, shop.name), imprint: shop.name },
    );
    const res = await emailTransport().send({ to, ...mail });
    await db().emailEvent.create({ data: { shopId: shop.id, type: "TEST_SENT", detail: `Stufe ${body.step} via ${emailTransport().kind}` } });
    await audit(shop.id, actor(req), "email.test", undefined, undefined, { step: body.step, transport: emailTransport().kind });
    return { ok: true, transport: emailTransport().kind, messageId: res.messageId };
  });

  // ─── Einstellungen ───
  const settingsSchema = z.object({
    firstRequestDaysAfterDelivery: z.number().int().min(3).max(5),
    fallbackDaysAfterOrder: z.number().int().min(7).max(30),
    reminderIntervalDays: z.number().int().min(1).max(14),
    maxAttempts: z.number().int().min(1).max(3),
    sendWindowStartHour: z.number().int().min(0).max(23),
    sendWindowEndHour: z.number().int().min(1).max(24),
    timezone: z.string().min(3),
    dailySendLimit: z.number().int().min(1).max(5000),
    freightPatterns: z.array(z.string().min(2)).max(50),
    legalBasis: z.enum(["NONE", "CONSENT", "UWG_7_3"]),
    remindersOnUnknownStatus: z.boolean(),
    includeRefundedOrders: z.boolean(),
    considerJudgemeInvitations: z.boolean(),
    testRecipients: z.array(z.string().email()).max(10),
  });

  app.get("/api/settings", async (req) => {
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shopId(req) } });
    return { ...rule, blockedReason: sendingBlockedReason(rule), allowCustomerEmailsEnv: config().ALLOW_CUSTOMER_EMAILS, transport: config().EMAIL_TRANSPORT };
  });

  app.put("/api/settings", write, async (req) => {
    const body = settingsSchema.parse(req.body);
    if (body.sendWindowEndHour <= body.sendWindowStartHour) throw Object.assign(new Error("Versandfenster: Ende muss nach Beginn liegen"), { statusCode: 400 });
    const before = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shopId(req) } });
    // Wechsel der Rechtsgrundlage → Versand automatisch wieder sperren (neue Freigabe nötig)
    const data = { ...body, ...(before.legalBasis !== body.legalBasis ? { sendingEnabled: false } : {}) };
    const rule = await db().reviewRule.update({ where: { shopId: shopId(req) }, data });
    await audit(shopId(req), actor(req), "settings.update", "review_rule", rule.id, body);
    await enqueue("plan-campaigns", {}, { dedupeKey: `plan-campaigns:settings:${Date.now()}` });
    return rule;
  });

  app.get("/api/release-checklist", async (req) => releaseChecklist(shopId(req)));

  app.post("/api/settings/release", write, async (req) => {
    if (req.user!.role !== "OWNER") throw Object.assign(new Error("Nur der Inhaber darf den Versand freigeben"), { statusCode: 403 });
    const body = z.object({ confirmation: z.string(), acknowledgeJudgemeParallel: z.boolean().default(false), confirmUwgNotice: z.boolean().default(false) }).parse(req.body);
    if (body.confirmation !== RELEASE_PHRASE) throw Object.assign(new Error(`Bitte „${RELEASE_PHRASE}“ eingeben`), { statusCode: 400 });
    const checklist = await releaseChecklist(shopId(req));
    const blocking = checklist.items.filter((i) => i.blocking && !i.ok);
    if (blocking.length) throw Object.assign(new Error(`Freigabe nicht möglich: ${blocking.map((b) => b.label).join(", ")}`), { statusCode: 400 });
    if (checklist.judgemeWarning && !body.acknowledgeJudgemeParallel) {
      throw Object.assign(new Error("Bitte bestätigen, dass parallel Judge.me-E-Mails versendet werden können"), { statusCode: 400 });
    }
    const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shopId(req) } });
    if (rule.legalBasis === "UWG_7_3" && !body.confirmUwgNotice) {
      throw Object.assign(new Error("Bitte bestätigen, dass Kunden bei der Bestellung auf das Widerspruchsrecht gegen Bewertungsanfragen hingewiesen werden (§ 7 Abs. 3 Nr. 4 UWG)"), { statusCode: 400 });
    }
    await db().reviewRule.update({
      where: { shopId: shopId(req) },
      data: { sendingEnabled: true, sendingReleasedAt: new Date(), sendingReleasedBy: req.user!.email, ...(rule.legalBasis === "UWG_7_3" ? { uwgNoticeConfirmedAt: new Date() } : {}) },
    });
    await audit(shopId(req), actor(req), "sending.release", undefined, undefined, { acknowledgeJudgemeParallel: body.acknowledgeJudgemeParallel, legalBasis: rule.legalBasis, confirmUwgNotice: body.confirmUwgNotice });
    return { ok: true };
  });

  app.post("/api/settings/stop", write, async (req) => {
    await db().reviewRule.update({ where: { shopId: shopId(req) }, data: { sendingEnabled: false } });
    await audit(shopId(req), actor(req), "sending.stop");
    return { ok: true };
  });

  // ─── Plattformen ───
  app.get("/api/platforms", async (req) => db().reviewPlatform.findMany({ where: { shopId: shopId(req) }, orderBy: { priority: "asc" } }));
  app.put<{ Params: { id: string } }>("/api/platforms/:id", write, async (req) => {
    const p = await db().reviewPlatform.findFirst({ where: { id: req.params.id, shopId: shopId(req) } });
    if (!p) throw Object.assign(new Error("Plattform nicht gefunden"), { statusCode: 404 });
    const body = z
      .object({
        active: z.boolean(),
        reviewUrl: z.string().url().startsWith("https://").nullable(),
        remindersAllowed: z.boolean(),
        priority: z.number().int().min(0).max(1000),
        targetShare: z.number().int().min(0).max(100),
        extraDelayDays: z.number().int().min(0).max(14),
        onlyForChannels: z.array(z.enum(SALES_CHANNELS)),
        notes: z.string().max(2000).nullable(),
      })
      .parse(req.body);
    const urlProblem = body.reviewUrl ? reviewUrlProblem(p.key, body.reviewUrl) : null;
    if (urlProblem) throw Object.assign(new Error(urlProblem), { statusCode: 400 });
    if (body.active && p.integrationType === "LINK" && !body.reviewUrl) throw Object.assign(new Error("Aktive Link-Plattform braucht einen offiziellen Bewertungslink"), { statusCode: 400 });
    if (body.active && p.integrationType === "EXTERNAL_PROGRAM" && body.targetShare > 0) {
      throw Object.assign(new Error("Diese Plattform versendet selbst – kein Anteil an ReviewPilot-E-Mails möglich"), { statusCode: 400 });
    }
    const updated = await db().reviewPlatform.update({ where: { id: p.id }, data: body });
    await audit(shopId(req), actor(req), "platform.update", "review_platform", p.id, body);
    return updated;
  });

  // ─── Vorlagen ───
  app.get("/api/templates", async (req) => db().emailTemplate.findMany({ where: { shopId: shopId(req) }, orderBy: [{ scope: "asc" }, { step: "asc" }] }));
  app.put("/api/templates", write, async (req) => {
    const body = z.object({ scope: z.string().min(1), step: z.number().int().min(1).max(3), subject: z.string().min(3).max(200), bodyText: z.string().min(10).max(10000) }).parse(req.body);
    const unknown = [...findUnknownPlaceholders(body.subject), ...findUnknownPlaceholders(body.bodyText)];
    if (unknown.length) throw Object.assign(new Error(`Unbekannte Platzhalter: ${unknown.join(", ")}`), { statusCode: 400 });
    const policy = templatePolicyProblems(`${body.subject}
${body.bodyText}`);
    if (policy.length) throw Object.assign(new Error(policy.join("; ")), { statusCode: 400 });
    if (!body.bodyText.includes("{{review_link}}")) throw Object.assign(new Error("Die Vorlage muss {{review_link}} enthalten"), { statusCode: 400 });
    const platform = body.scope === "default" ? null : await db().reviewPlatform.findFirst({ where: { shopId: shopId(req), key: body.scope as never } });
    if (body.scope !== "default" && !platform) throw Object.assign(new Error("Unbekannte Plattform"), { statusCode: 400 });
    const t = await db().emailTemplate.upsert({
      where: { shopId_scope_step: { shopId: shopId(req), scope: body.scope, step: body.step } },
      create: { shopId: shopId(req), scope: body.scope, step: body.step, subject: body.subject, bodyText: body.bodyText, platformId: platform?.id },
      update: { subject: body.subject, bodyText: body.bodyText },
    });
    await audit(shopId(req), actor(req), "template.update", "email_template", t.id);
    return t;
  });
  app.post("/api/templates/preview", async (req) => {
    const body = z.object({ subject: z.string(), bodyText: z.string() }).parse(req.body);
    const shop = await db().shop.findUniqueOrThrow({ where: { id: shopId(req) }, include: { rule: true } });
    return renderEmail(body.subject, body.bodyText, { first_name: "Max", review_link: clickUrl("vorschau"), order_name: "#1001", shop_name: shop.name }, {
      unsubscribeUrl: `${config().PUBLIC_BASE_URL}/u/vorschau`,
      legalBasisNotice: legalNotice(shop.rule!.legalBasis, shop.name),
      imprint: shop.name,
    });
  });

  // ─── Kanal-Mapping ───
  app.get("/api/channel-mappings", async (req) => db().channelMappingRule.findMany({ where: { shopId: shopId(req) }, orderBy: [{ priority: "asc" }, { pattern: "asc" }] }));
  app.post("/api/channel-mappings", write, async (req) => {
    const body = z
      .object({ field: z.enum(["utm_source", "utm_medium", "referrer_host", "landing_page", "source_name"]), pattern: z.string().min(2).max(100), channel: z.enum(SALES_CHANNELS), priority: z.number().int().min(0).max(1000) })
      .parse(req.body);
    const r = await db().channelMappingRule.create({ data: { shopId: shopId(req), ...body } });
    await audit(shopId(req), actor(req), "channel_mapping.create", "channel_mapping_rule", r.id, body);
    return r;
  });
  app.delete<{ Params: { id: string } }>("/api/channel-mappings/:id", write, async (req) => {
    await db().channelMappingRule.deleteMany({ where: { id: req.params.id, shopId: shopId(req) } });
    await audit(shopId(req), actor(req), "channel_mapping.delete", "channel_mapping_rule", req.params.id);
    return { ok: true };
  });

  // ─── Integrationen ───
  app.get("/api/integrations", async (req) => {
    const rows = await db().shopIntegration.findMany({ where: { shopId: shopId(req) } });
    const c = config();
    return {
      shopify: { configured: shopifyConfigured(), mode: c.SHOPIFY_ACCESS_TOKEN ? "Admin-API-Token" : "Client Credentials", domain: c.SHOPIFY_SHOP_DOMAIN ?? null, apiVersion: c.SHOPIFY_API_VERSION, webhookSecret: !!c.SHOPIFY_CLIENT_SECRET },
      email: { transport: c.EMAIL_TRANSPORT, from: c.EMAIL_FROM ?? null, allowCustomerEmails: c.ALLOW_CUSTOMER_EMAILS },
      judgeme: { ...(rows.find((r) => r.provider === "judgeme") ?? { status: "NOT_CONFIGURED", statusDetail: null, lastCheckedAt: null }), encryptedConfig: undefined, capabilities: JUDGEME_CAPABILITIES },
    };
  });
  app.put("/api/integrations/judgeme", write, async (req) => {
    const body = z.object({ shopDomain: z.string().min(3), apiToken: z.string().min(10) }).parse(req.body);
    await saveJudgemeConfig(shopId(req), body);
    await audit(shopId(req), actor(req), "integration.judgeme.save");
    return testJudgeme(shopId(req));
  });
  app.post("/api/integrations/judgeme/test", write, async (req) => testJudgeme(shopId(req)));

  app.post("/api/integrations/shopify/test", write, async () => {
    const client = ShopifyClient.fromEnv();
    const data = await client.graphql<{ shop: { name: string; myshopifyDomain: string; ianaTimezone: string } }>(SHOP_INFO);
    return { ok: true, shop: data.shop };
  });
  app.post("/api/integrations/shopify/register-webhooks", write, async (req) => {
    const client = ShopifyClient.fromEnv();
    const uri = `${config().PUBLIC_BASE_URL}/webhooks/shopify`;
    if (!uri.startsWith("https://")) throw Object.assign(new Error("PUBLIC_BASE_URL muss https sein"), { statusCode: 400 });
    const existing = await client.graphql<{ webhookSubscriptions: { nodes: { topic: string; uri: string }[] } }>(WEBHOOK_SUBSCRIPTIONS);
    const results: { topic: string; status: string }[] = [];
    for (const topic of WEBHOOK_TOPICS) {
      if (existing.webhookSubscriptions.nodes.some((n) => n.topic === topic && n.uri === uri)) {
        results.push({ topic, status: "vorhanden" });
        continue;
      }
      const res = await client.graphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(WEBHOOK_CREATE, { topic, uri });
      const errors = res.webhookSubscriptionCreate.userErrors;
      results.push({ topic, status: errors.length ? `Fehler: ${errors.map((e) => e.message).join("; ")}` : "angelegt" });
    }
    await audit(shopId(req), actor(req), "shopify.register_webhooks", undefined, undefined, results);
    return results;
  });
  app.post("/api/sync/orders", write, async (req) => {
    const body = z.object({ full: z.boolean().default(false), initialDays: z.number().int().min(1).max(60).default(60) }).parse(req.body ?? {});
    await enqueue("sync-orders", { shopId: shopId(req), ...body }, { dedupeKey: `sync-orders:manual:${Math.floor(Date.now() / 60_000)}` });
    return { queued: true };
  });

  // ─── Sperrliste, DSGVO, Audit, Jobs ───
  app.get("/api/suppressions", async (req) => db().emailSuppression.findMany({ where: { shopId: shopId(req) }, orderBy: { createdAt: "desc" }, take: 500 }));
  app.post("/api/suppressions", write, async (req) => {
    const body = z.object({ email: z.string().email(), reason: z.enum(["OBJECTION", "MANUAL"]) }).parse(req.body);
    const email = body.email.toLowerCase();
    await db().emailSuppression.upsert({ where: { shopId_email: { shopId: shopId(req), email } }, create: { shopId: shopId(req), email, reason: body.reason }, update: {} });
    if (body.reason === "OBJECTION") await db().consentRecord.create({ data: { shopId: shopId(req), email, status: "OBJECTED", source: "manual" } });
    for (const o of await db().order.findMany({ where: { shopId: shopId(req), email }, select: { id: true } })) await evaluateOrder(o.id);
    await audit(shopId(req), actor(req), "suppression.create", undefined, undefined, { reason: body.reason });
    return { ok: true };
  });
  app.post("/api/consents", write, async (req) => {
    const body = z.object({ email: z.string().email(), status: z.enum(["GRANTED", "REVOKED", "OBJECTED"]), detail: z.string().max(500).optional() }).parse(req.body);
    const email = body.email.toLowerCase();
    await db().consentRecord.create({ data: { shopId: shopId(req), email, status: body.status, source: "manual", detail: body.detail } });
    for (const o of await db().order.findMany({ where: { shopId: shopId(req), email }, select: { id: true } })) await evaluateOrder(o.id);
    await audit(shopId(req), actor(req), "consent.record", undefined, undefined, { status: body.status });
    return { ok: true };
  });
  app.get("/api/gdpr/export", async (req) => {
    const q = z.object({ email: z.string().email() }).parse(req.query);
    await audit(shopId(req), actor(req), "gdpr.export");
    return exportPersonalData(shopId(req), q.email);
  });
  app.post("/api/gdpr/delete", write, async (req) => {
    const body = z.object({ email: z.string().email(), confirm: z.literal(true) }).parse(req.body);
    return { orders: await deletePersonalData(shopId(req), body.email, actor(req)) };
  });
  app.get("/api/audit", async (req) => db().auditLog.findMany({ where: { shopId: shopId(req) }, orderBy: { createdAt: "desc" }, take: 200 }));
  app.get("/api/jobs", async () => {
    const [counts, dead] = await Promise.all([
      db().job.groupBy({ by: ["status"], _count: { _all: true } }),
      db().job.findMany({ where: { status: "DEAD" }, orderBy: { finishedAt: "desc" }, take: 50 }),
    ]);
    return { counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), dead };
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", write, async (req) => {
    await db().job.updateMany({ where: { id: req.params.id, status: "DEAD" }, data: { status: "PENDING", attempts: 0, runAt: new Date(), finishedAt: null } });
    return { ok: true };
  });
}

export async function releaseChecklist(shop: string) {
  const c = config();
  const rule = await db().reviewRule.findUniqueOrThrow({ where: { shopId: shop } });
  const platforms = await db().reviewPlatform.findMany({ where: { shopId: shop } });
  const templates = await db().emailTemplate.count({ where: { shopId: shop, scope: "default" } });
  const judgeme = await db().shopIntegration.findUnique({ where: { shopId_provider: { shopId: shop, provider: "judgeme" } } });
  const items = [
    { label: "Rechtsgrundlage festgelegt", ok: rule.legalBasis !== "NONE", blocking: true },
    { label: "SMTP-Versand konfiguriert (EMAIL_TRANSPORT=smtp, Passwort gesetzt)", ok: c.EMAIL_TRANSPORT === "smtp" && !!c.SMTP_HOST && !!c.EMAIL_FROM && (!c.SMTP_USER || !!c.SMTP_PASSWORD), blocking: true },
    { label: "ALLOW_CUSTOMER_EMAILS=true auf dem Server", ok: c.ALLOW_CUSTOMER_EMAILS, blocking: true },
    { label: "Öffentliche HTTPS-URL für Links (PUBLIC_BASE_URL)", ok: c.PUBLIC_BASE_URL.startsWith("https://"), blocking: true },
    { label: "Mindestens eine aktive Plattform mit offiziellem Link", ok: platforms.some((p) => p.active && p.integrationType === "LINK" && !!p.reviewUrl), blocking: true },
    { label: "E-Mail-Vorlagen für alle Stufen", ok: templates >= rule.maxAttempts, blocking: true },
    { label: "Testempfänger hinterlegt und Test-E-Mail geprüft", ok: rule.testRecipients.length > 0 && (await db().emailEvent.count({ where: { shopId: shop, type: "TEST_SENT" } })) > 0, blocking: true },
    { label: "Judge.me-Bewertungen abrufbar (Koordination)", ok: judgeme?.status === "OK", blocking: false },
  ];
  // Judge.me-Einladungen sind laut Doku nicht per API abrufbar → vor Aktivierung immer warnen
  const judgemeWarning =
    "Judge.me-Einladungen können nicht synchronisiert werden (keine dokumentierte API). Kunden erhalten ggf. parallel eine Judge.me-Produktbewertungsanfrage und eine ReviewPilot-Händlerbewertungsanfrage." +
    (rule.considerJudgemeInvitations ? " Bereits abgegebene Judge.me-Bewertungen stoppen die ReviewPilot-Kampagne, sofern die Judge.me-Verbindung aktiv ist." : "");
  return { items, judgemeWarning, released: rule.sendingEnabled, releasedAt: rule.sendingReleasedAt, releasedBy: rule.sendingReleasedBy };
}
