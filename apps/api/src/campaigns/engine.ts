import { createHash } from "node:crypto";
import type { CampaignStatus, Prisma } from "@prisma/client";
import { planCampaign, resolveSendTime, stepDates, type PlanInput, type PlatformOption } from "../domain/planner.js";
import { MANUAL_CANCEL_REASON, MANUAL_PAUSE_REASON, toRuleSettings } from "../domain/settings.js";
import { intoSendWindow } from "../domain/time.js";
import { db } from "../lib/db.js";

/** Endzustände – werden nicht mehr automatisch umgeplant */
export const CLOSED_STATUSES: CampaignStatus[] = ["COMPLETED", "CANCELLED", "REVIEW_RECEIVED", "REVIEW_STATUS_UNKNOWN"];
const OPEN_INVITATION = ["SCHEDULED"] as const;

type Tx = Prisma.TransactionClient;

export async function consentStateFor(tx: Tx, shopId: string, email: string | null): Promise<PlanInput["consent"]> {
  if (!email) return "NONE";
  const last = await tx.consentRecord.findFirst({ where: { shopId, email }, orderBy: { recordedAt: "desc" } });
  return last?.status ?? "NONE";
}

/**
 * Sperrliste: Klartext-Adresse oder – nach DSGVO-Löschung – nur noch ihr SHA-256-Hash. So bleibt eine Abmeldung
 * wirksam, auch wenn die Person später erneut bestellt, ohne dass die Adresse selbst gespeichert bleibt.
 */
export async function isSuppressed(tx: Tx, shopId: string, email: string | null): Promise<boolean> {
  if (!email) return false;
  const e = email.toLowerCase();
  return (await tx.emailSuppression.count({ where: { shopId, email: { in: [email, e, suppressionHash(e)] } } })) > 0;
}

export function suppressionHash(email: string): string {
  return `sha256:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

/** Können für eine Plattform überhaupt Erinnerungen (Stufe 2/3) eingeplant werden? */
export function plannedSteps(maxAttempts: number, p: { remindersAllowed: boolean; statusQueryAvailable: boolean }, remindersOnUnknownStatus: boolean): number {
  if (!p.remindersAllowed) return 1;
  if (!p.statusQueryAvailable && !remindersOnUnknownStatus) return 1;
  return Math.max(1, maxAttempts);
}

async function cancelOpenInvitations(tx: Tx, campaignId: string, reason: string): Promise<void> {
  await tx.reviewInvitation.updateMany({
    where: { campaignId, status: { in: [...OPEN_INVITATION] } },
    data: { status: "CANCELLED", statusReason: reason },
  });
}

/**
 * Bewertet eine Bestellung (neu) und legt die Kampagne an bzw. aktualisiert sie. Idempotent:
 * - genau eine Kampagne pro Bestellung (Unique orderId)
 * - genau eine Einladung pro Stufe (Unique campaignId+step); versendete Stufen werden nie verändert.
 */
export async function evaluateOrder(orderId: string, now = new Date()): Promise<CampaignStatus | null> {
  return db().$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { campaign: { include: { invitations: true } } } });
    const ruleRow = await tx.reviewRule.findUnique({ where: { shopId: order.shopId } });
    if (!ruleRow) return null;
    const s = toRuleSettings(ruleRow);
    const platforms = await tx.reviewPlatform.findMany({ where: { shopId: order.shopId } });

    let campaign = order.campaign;
    if (campaign && CLOSED_STATUSES.includes(campaign.status)) return campaign.status;
    if (campaign?.status === "PAUSED" && campaign.statusReason === MANUAL_PAUSE_REASON) return campaign.status;

    const input: PlanInput = {
      orderId: order.id,
      orderCreatedAt: order.orderCreatedAt,
      isTest: order.isTest,
      email: order.email,
      cancelledAt: order.cancelledAt,
      totalPrice: Number(order.totalPrice),
      totalRefunded: Number(order.totalRefunded),
      deliveryStatus: order.deliveryStatus,
      deliveredAt: order.deliveredAt,
      fullyShipped: !!order.shippedAt && (order.fulfillmentStatus == null || order.fulfillmentStatus === "FULFILLED"),
      shippedAt: order.shippedAt,
      hasTracking: order.hasTracking,
      isFreight: order.isFreight,
      channel: order.channel,
      reviewBlocked: order.reviewBlocked,
      suppressed: await isSuppressed(tx, order.shopId, order.email),
      consent: await consentStateFor(tx, order.shopId, order.email),
    };

    const sent = campaign?.invitations.filter((i) => i.status === "SENT" || i.status === "SENDING") ?? [];
    // Nach dem ersten Versand bleibt die Plattform fest (kein Plattformwechsel innerhalb einer Kampagne)
    const lockedPlatform = sent.length && campaign?.platformId ? platforms.filter((p) => p.id === campaign!.platformId) : platforms;
    const plan = planCampaign(input, s, lockedPlatform as PlatformOption[]);

    if (!campaign) {
      campaign = await tx.reviewCampaign.create({ data: { shopId: order.shopId, orderId: order.id, status: "PENDING" }, include: { invitations: true } });
    }

    if (plan.kind === "terminal") {
      await cancelOpenInvitations(tx, campaign.id, plan.reason);
      await tx.reviewCampaign.update({ where: { id: campaign.id }, data: { status: plan.status, statusReason: plan.reason, closedAt: plan.status === "CANCELLED" ? now : null } });
      return plan.status;
    }
    if (plan.kind === "wait") {
      await cancelOpenInvitations(tx, campaign.id, plan.reason);
      await tx.reviewCampaign.update({ where: { id: campaign.id }, data: { status: plan.status, statusReason: plan.reason, pausedAt: plan.status === "PAUSED" ? now : null } });
      return plan.status;
    }

    // Planung: bereits versendete Stufen behalten Regel und Anker
    const rule = sent.length && campaign.shippingRule ? campaign.shippingRule : plan.rule;
    const anchorAt = sent.length && campaign.anchorAt ? campaign.anchorAt : plan.anchorAt;
    const platformRow = platforms.find((p) => p.id === plan.platform.id)!;
    const steps = plannedSteps(s.maxAttempts, platformRow, ruleRow.remindersOnUnknownStatus);
    const dates = stepDates(rule, anchorAt, s, platformRow.extraDelayDays).slice(0, steps);

    const ruleChanged = campaign.shippingRule !== rule || campaign.anchorAt?.getTime() !== anchorAt.getTime();
    for (let i = 0; i < dates.length; i++) {
      const step = i + 1;
      const existing = campaign.invitations.find((inv) => inv.step === step);
      if (existing?.manual) continue; // manuelle Erinnerungen werden nicht automatisch umgeplant
      // Versendete, übersprungene und fehlgeschlagene Stufen nie neu planen (keine Doppel-Mails)
      if (existing && ["SENT", "SENDING", "SKIPPED", "FAILED"].includes(existing.status)) continue;
      // Bereits geplante Stufe nur verschieben, wenn sich Regel/Anker geändert haben (z. B. B → A nach Zustellbestätigung)
      if (existing?.status === "SCHEDULED" && !ruleChanged) continue;
      const resolved = resolveSendTime(dates[i]!, now, s);
      if ("missed" in resolved) {
        if (step === 1 && sent.length === 0) {
          await cancelOpenInvitations(tx, campaign.id, "Versandzeitpunkt verstrichen");
          await tx.reviewCampaign.update({
            where: { id: campaign.id },
            data: { status: "CANCELLED", statusReason: "Versandzeitpunkt verstrichen – keine rückwirkende Versendung", closedAt: now, shippingRule: rule, anchorAt, platformId: plan.platform.id },
          });
          return "CANCELLED";
        }
        await tx.reviewInvitation.upsert({
          where: { campaignId_step: { campaignId: campaign.id, step } },
          create: { campaignId: campaign.id, step, scheduledAt: dates[i]!, status: "SKIPPED", statusReason: "Versandzeitpunkt verstrichen" },
          update: { status: "SKIPPED", statusReason: "Versandzeitpunkt verstrichen" },
        });
        continue;
      }
      await tx.reviewInvitation.upsert({
        where: { campaignId_step: { campaignId: campaign.id, step } },
        create: { campaignId: campaign.id, step, scheduledAt: resolved.at, status: "SCHEDULED" },
        update: { scheduledAt: resolved.at, status: "SCHEDULED", statusReason: null, lastError: null },
      });
    }
    // Überzählige, noch offene Stufen (z. B. Erinnerungen nicht mehr zulässig) abbrechen
    await tx.reviewInvitation.updateMany({
      where: { campaignId: campaign.id, step: { gt: dates.length }, manual: false, status: { in: [...OPEN_INVITATION] } },
      data: { status: "CANCELLED", statusReason: "Keine Erinnerungen zulässig" },
    });

    const status: CampaignStatus = sent.length ? "ACTIVE" : "SCHEDULED";
    await tx.reviewCampaign.update({
      where: { id: campaign.id },
      data: { status, statusReason: null, shippingRule: rule, anchorAt, platformId: plan.platform.id, pausedAt: null },
    });
    return status;
  });
}

export async function pauseCampaign(campaignId: string, actor: string): Promise<void> {
  await db().$transaction(async (tx) => {
    const c = await tx.reviewCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (CLOSED_STATUSES.includes(c.status)) throw new Error("Kampagne ist bereits abgeschlossen");
    await cancelOpenInvitations(tx, campaignId, MANUAL_PAUSE_REASON);
    await tx.reviewCampaign.update({ where: { id: campaignId }, data: { status: "PAUSED", statusReason: MANUAL_PAUSE_REASON, pausedAt: new Date() } });
    await tx.auditLog.create({ data: { shopId: c.shopId, actor, action: "campaign.pause", entity: "review_campaign", entityId: campaignId } });
  });
}

export async function resumeCampaign(campaignId: string, actor: string): Promise<CampaignStatus | null> {
  const c = await db().reviewCampaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (c.status !== "PAUSED") throw new Error("Nur pausierte Kampagnen können fortgesetzt werden");
  await db().reviewCampaign.update({ where: { id: campaignId }, data: { status: "PENDING", statusReason: null, pausedAt: null } });
  await db().auditLog.create({ data: { shopId: c.shopId, actor, action: "campaign.resume", entity: "review_campaign", entityId: campaignId } });
  // Neubewertung nach den aktuellen Regeln (keine rückwirkende Massenversendung)
  return evaluateOrder(c.orderId);
}

export async function cancelCampaign(campaignId: string, actor: string, reason = MANUAL_CANCEL_REASON): Promise<void> {
  await db().$transaction(async (tx) => {
    const c = await tx.reviewCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    await cancelOpenInvitations(tx, campaignId, reason);
    await tx.reviewCampaign.update({ where: { id: campaignId }, data: { status: "CANCELLED", statusReason: reason, closedAt: new Date() } });
    await tx.auditLog.create({ data: { shopId: c.shopId, actor, action: "campaign.cancel", entity: "review_campaign", entityId: campaignId, data: { reason } } });
  });
}

export type ManualReminderCheck = { ok: true; step: number; earliest: Date } | { ok: false; reason: string };

/**
 * Darf für diese Kampagne manuell eine Erinnerung ausgelöst werden?
 * Grenzen: max. Kontaktversuche gesamt (Standard 3), Mindestabstand zur letzten E-Mail, keine bestätigte Bewertung,
 * keine offene geplante Einladung, Kampagne nicht gestoppt (Storno, Abmeldung, …).
 */
export async function manualReminderCheck(campaignId: string, now = new Date()): Promise<ManualReminderCheck> {
  const c = await db().reviewCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { invitations: true, shop: { include: { rule: true } }, platform: true } });
  const rule = c.shop.rule!;
  if (c.reviewStatus === "REVIEWED" || c.status === "REVIEW_RECEIVED") return { ok: false, reason: "Bewertung liegt bereits vor" };
  if (!["ACTIVE", "REVIEW_STATUS_UNKNOWN", "COMPLETED"].includes(c.status)) return { ok: false, reason: "Nur nach einer versendeten Anfrage möglich (Kampagne gestoppt oder noch nicht gestartet)" };
  if (!c.platform?.active || !c.platform.reviewUrl) return { ok: false, reason: "Plattform inaktiv oder ohne Bewertungslink" };
  const order = await db().order.findUniqueOrThrow({ where: { id: c.orderId } });
  if (!order.email) return { ok: false, reason: "Keine E-Mail-Adresse" };
  if (await isSuppressed(db(), c.shopId, order.email)) return { ok: false, reason: "Kunde hat sich ausgetragen bzw. widersprochen – wird nicht mehr kontaktiert" };
  if (c.invitations.some((i) => i.status === "SCHEDULED" || i.status === "SENDING")) return { ok: false, reason: "Es ist bereits eine Einladung geplant" };
  const sent = c.invitations.filter((i) => i.status === "SENT").sort((a, b) => a.step - b.step);
  if (!sent.length) return { ok: false, reason: "Noch keine Anfrage versendet" };
  // Gezählt werden versendete und unklare (FAILED) Kontakte; abgebrochene/übersprungene Stufen werden wiederverwendet
  const step = Math.max(...c.invitations.filter((i) => i.status === "SENT" || i.status === "FAILED").map((i) => i.step)) + 1;
  if (step > rule.maxAttempts) return { ok: false, reason: `Maximal ${rule.maxAttempts} Kontaktversuche pro Bestellung erreicht` };
  const lastSent = sent[sent.length - 1]!.sentAt!;
  const earliestByInterval = new Date(lastSent.getTime() + rule.reminderIntervalDays * 86400_000);
  return { ok: true, step, earliest: earliestByInterval > now ? earliestByInterval : now };
}

/** Plant eine manuelle Erinnerung (Versand über den normalen Sender inkl. aller Stopp- und Rechtsprüfungen) */
export async function scheduleManualReminder(campaignId: string, actor: string, now = new Date()): Promise<{ step: number; scheduledAt: Date }> {
  const check = await manualReminderCheck(campaignId, now);
  if (!check.ok) throw Object.assign(new Error(check.reason), { statusCode: 400 });
  const c = await db().reviewCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { shop: { include: { rule: true } } } });
  const rule = c.shop.rule!;
  const scheduledAt = intoSendWindow(check.earliest, rule.sendWindowStartHour, rule.sendWindowEndHour, rule.timezone);
  await db().$transaction([
    db().reviewInvitation.upsert({
      where: { campaignId_step: { campaignId, step: check.step } },
      create: { campaignId, step: check.step, manual: true, scheduledAt, status: "SCHEDULED", statusReason: "Manuelle Erinnerung" },
      update: { manual: true, scheduledAt, status: "SCHEDULED", statusReason: "Manuelle Erinnerung", attempts: 0, lastError: null },
    }),
    db().reviewCampaign.update({ where: { id: campaignId }, data: { status: "ACTIVE", statusReason: "Manuelle Erinnerung geplant", closedAt: null } }),
    db().auditLog.create({ data: { shopId: c.shopId, actor, action: "campaign.manual_reminder", entity: "review_campaign", entityId: campaignId, data: { step: check.step, scheduledAt } } }),
  ]);
  return { step: check.step, scheduledAt };
}

/** Bewertung bestätigt (API oder manuell) → Kampagne beenden, offene Einladungen abbrechen */
export async function markReviewReceived(campaignId: string, reason: string): Promise<void> {
  await db().$transaction(async (tx) => {
    await cancelOpenInvitations(tx, campaignId, "Bewertung liegt vor");
    await tx.reviewCampaign.update({ where: { id: campaignId }, data: { status: "REVIEW_RECEIVED", reviewStatus: "REVIEWED", statusReason: reason, closedAt: new Date() } });
  });
}
