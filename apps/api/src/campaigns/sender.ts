import { Prisma, type LegalBasis } from "@prisma/client";
import { config } from "../config.js";
import { MAX_LATE_HOURS } from "../domain/planner.js";
import { reminderDecision } from "../domain/reminders.js";
import { addDays, localYmd, zonedTime } from "../domain/time.js";
import { renderEmail, type LegalFooter } from "../email/render.js";
import { EmailSendError, emailTransport } from "../email/transport.js";
import { sign } from "../lib/crypto.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { hasJudgemeReviewSince } from "../platforms/judgeme.js";
import { evaluateOrder, markReviewReceived, plannedSteps } from "./engine.js";

const MAX_SEND_RETRIES = 3;

export function legalNotice(basis: LegalBasis, shopName: string): string {
  if (basis === "UWG_7_3") {
    return `Du erhältst diese E-Mail als Kunde von ${shopName}, weil du bei uns bestellt hast. Du kannst der Verwendung deiner E-Mail-Adresse für Bewertungsanfragen jederzeit widersprechen, ohne dass hierfür andere als die Übermittlungskosten nach den Basistarifen entstehen.`;
  }
  return `Du erhältst diese E-Mail, weil du Bewertungsanfragen von ${shopName} zugestimmt hast. Du kannst deine Einwilligung jederzeit widerrufen.`;
}

export function unsubscribeUrl(shopId: string, email: string): string {
  return `${config().PUBLIC_BASE_URL}/u/${sign(`${shopId}|${email}`, "unsubscribe")}`;
}

export function clickUrl(trackingToken: string): string {
  return `${config().PUBLIC_BASE_URL}/r/${trackingToken}`;
}

/** Globale Versandsperre: Freigabe im Dashboard UND ALLOW_CUSTOMER_EMAILS UND Rechtsgrundlage */
export function sendingBlockedReason(rule: { sendingEnabled: boolean; legalBasis: LegalBasis }): string | null {
  if (!config().ALLOW_CUSTOMER_EMAILS) return "ALLOW_CUSTOMER_EMAILS ist nicht gesetzt";
  if (!rule.sendingEnabled) return "Versand nicht freigegeben";
  if (rule.legalBasis === "NONE") return "Keine Rechtsgrundlage konfiguriert";
  return null;
}

/** Atomar fällige Einladungen reservieren (SKIP LOCKED → mehrere Worker sicher) */
async function claimDue(limit: number, now: Date): Promise<string[]> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    UPDATE review_invitations SET status = 'SENDING', updated_at = now()
    WHERE id IN (
      SELECT i.id FROM review_invitations i
      JOIN review_campaigns c ON c.id = i.campaign_id
      JOIN review_rules r ON r.shop_id = c.shop_id
      WHERE i.status = 'SCHEDULED' AND i.scheduled_at <= ${now}
        AND c.status IN ('SCHEDULED', 'ACTIVE')
        AND r.sending_enabled = true AND r.legal_basis <> 'NONE'
      ORDER BY i.scheduled_at
      LIMIT ${limit}
      FOR UPDATE OF i SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => r.id);
}

async function setInvitation(id: string, data: Prisma.ReviewInvitationUpdateInput): Promise<void> {
  await db().reviewInvitation.update({ where: { id }, data });
}

/** Verarbeitet fällige Einladungen. Rückgabe: Anzahl tatsächlich versendeter E-Mails. */
export async function sendDueInvitations(now = new Date(), limit = 25): Promise<number> {
  if (!config().ALLOW_CUSTOMER_EMAILS) return 0;
  const ids = await claimDue(limit, now);
  let sentCount = 0;
  for (const id of ids) {
    try {
      if (await processInvitation(id, now)) sentCount++;
    } catch (err) {
      logger.error({ err, invitationId: id }, "Einladung konnte nicht verarbeitet werden");
      // Unklarer Zustand → nicht erneut senden (keine Doppel-Mails), sondern als Fehler markieren
      await setInvitation(id, { status: "FAILED", lastError: (err as Error).message.slice(0, 500) });
    }
  }
  return sentCount;
}

async function processInvitation(id: string, now: Date): Promise<boolean> {
  const prisma = db();
  const inv = await prisma.reviewInvitation.findUniqueOrThrow({
    where: { id },
    include: { campaign: { include: { order: true, platform: true, shop: { include: { rule: true } } } } },
  });
  const { campaign } = inv;
  const { order, shop } = campaign;
  const rule = shop.rule!;
  const skip = (reason: string) => setInvitation(id, { status: "SKIPPED", statusReason: reason });

  const blocked = sendingBlockedReason(rule);
  if (blocked) {
    await setInvitation(id, { status: "SCHEDULED" });
    return false;
  }
  // Keine rückwirkende Massenversendung (z. B. nach längerer Versandsperre)
  if (now.getTime() - inv.scheduledAt.getTime() > MAX_LATE_HOURS * 3600_000) {
    await skip("Versandzeitpunkt verstrichen");
    if (inv.step === 1) await prisma.reviewCampaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED", statusReason: "Versandzeitpunkt verstrichen – keine rückwirkende Versendung", closedAt: now } });
    return false;
  }

  // Stoppbedingungen frisch prüfen (Storno, Erstattung, Widerruf, Abmeldung …)
  await setInvitation(id, { status: "SCHEDULED" });
  const status = await evaluateOrder(order.id, now);
  const fresh = await prisma.reviewInvitation.findUniqueOrThrow({ where: { id } });
  if (fresh.status !== "SCHEDULED" || fresh.scheduledAt > now || !status || !["SCHEDULED", "ACTIVE"].includes(status)) return false;
  // erneut reservieren
  const claimed = await prisma.reviewInvitation.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "SENDING" } });
  if (claimed.count !== 1) return false;

  const platform = campaign.platform;
  if (!platform || !platform.active || !platform.reviewUrl || !order.email) {
    await skip("Plattform inaktiv oder ohne Bewertungslink");
    return false;
  }

  // Judge.me-Koordination: bereits abgegebene Judge.me-Bewertung beendet die Kampagne
  if (rule.considerJudgemeInvitations) {
    const review = await hasJudgemeReviewSince(shop.id, order.email, order.orderCreatedAt);
    if (review) {
      await skip("Judge.me-Bewertung vorhanden");
      await prisma.reviewEvent.upsert({
        where: { shopId_platformId_externalId: { shopId: shop.id, platformId: (await judgemePlatformId(shop.id)) ?? platform.id, externalId: String(review.id) } },
        create: { shopId: shop.id, platformId: (await judgemePlatformId(shop.id)) ?? null, orderId: order.id, campaignId: campaign.id, type: "REVIEW_CONFIRMED", externalId: String(review.id), rating: review.rating, occurredAt: new Date(review.created_at) },
        update: {},
      });
      await markReviewReceived(campaign.id, "Judge.me-Bewertung vorhanden");
      return false;
    }
  }

  // Erinnerungen nur, wenn zulässig
  // Automatische Erinnerungen nur, wenn zulässig. Manuelle Erinnerungen hat ein Admin bewusst ausgelöst
  // (nach Prüfung, dass keine Bewertung vorliegt) – Stopp-, Rechts- und Sperrprüfungen gelten trotzdem.
  if (inv.step >= 2 && !inv.manual) {
    const decision = reminderDecision({
      step: inv.step,
      reviewStatus: campaign.reviewStatus,
      platformRemindersAllowed: platform.remindersAllowed,
      platformStatusQueryAvailable: platform.statusQueryAvailable,
      remindersOnUnknownStatus: rule.remindersOnUnknownStatus,
    });
    if (!decision.allowed) {
      await skip(decision.reason);
      await prisma.reviewInvitation.updateMany({ where: { campaignId: campaign.id, step: { gt: inv.step }, status: "SCHEDULED" }, data: { status: "CANCELLED", statusReason: decision.reason } });
      await prisma.reviewCampaign.update({ where: { id: campaign.id }, data: { status: decision.unknown ? "REVIEW_STATUS_UNKNOWN" : "COMPLETED", statusReason: decision.reason, closedAt: now } });
      return false;
    }
  }

  // Tageslimit (Shop-Zeitzone) → auf nächsten Tag verschieben
  const dayStart = zonedTime(localYmd(now, rule.timezone), 0, rule.timezone);
  const sentToday = await prisma.reviewInvitation.count({ where: { sentAt: { gte: dayStart }, campaign: { shopId: shop.id } } });
  if (sentToday >= rule.dailySendLimit) {
    await setInvitation(id, { status: "SCHEDULED", scheduledAt: zonedTime(addDays(localYmd(now, rule.timezone), 1), rule.sendWindowStartHour, rule.timezone), statusReason: "Tageslimit erreicht" });
    return false;
  }

  const template =
    (await prisma.emailTemplate.findUnique({ where: { shopId_scope_step: { shopId: shop.id, scope: platform.key, step: inv.step } } })) ??
    (await prisma.emailTemplate.findUnique({ where: { shopId_scope_step: { shopId: shop.id, scope: "default", step: inv.step } } }));
  if (!template) {
    await setInvitation(id, { status: "FAILED", lastError: `Keine Vorlage für Stufe ${inv.step}` });
    return false;
  }

  const unsub = unsubscribeUrl(shop.id, order.email);
  const footer: LegalFooter = { unsubscribeUrl: unsub, legalBasisNotice: legalNotice(rule.legalBasis, shop.name), imprint: shop.name };
  const mail = renderEmail(template.subject, template.bodyText, { first_name: order.firstName, review_link: clickUrl(inv.trackingToken), order_name: order.name, shop_name: shop.name }, footer);

  try {
    const res = await emailTransport().send({
      to: order.email,
      ...mail,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-ReviewPilot-Invitation": inv.id },
    });
    await prisma.$transaction([
      prisma.reviewInvitation.update({ where: { id }, data: { status: "SENT", sentAt: now, messageId: res.messageId, attempts: { increment: 1 }, lastError: null, statusReason: null } }),
      prisma.emailEvent.create({ data: { shopId: shop.id, invitationId: id, type: "SENT", detail: emailTransport().kind } }),
    ]);
    const steps = plannedSteps(rule.maxAttempts, platform, rule.remindersOnUnknownStatus);
    if (inv.step >= steps || inv.manual) {
      const unknown = campaign.reviewStatus === "UNKNOWN";
      await prisma.reviewCampaign.update({
        where: { id: campaign.id },
        data: { status: unknown ? "REVIEW_STATUS_UNKNOWN" : "COMPLETED", statusReason: inv.manual ? `Manuelle Erinnerung (Stufe ${inv.step}) versendet` : unknown ? "Alle Kontaktversuche versendet – Bewertungsstatus nicht abrufbar" : "Alle Kontaktversuche versendet", closedAt: now },
      });
    } else {
      await prisma.reviewCampaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE" } });
    }
    return true;
  } catch (err) {
    const e = err instanceof EmailSendError ? err : new EmailSendError((err as Error).message, false, false);
    const attempts = inv.attempts + 1;
    await prisma.emailEvent.create({ data: { shopId: shop.id, invitationId: id, type: e.recipientRejected ? "BOUNCED_HARD" : "FAILED", detail: e.message.slice(0, 500) } });
    if (e.recipientRejected) {
      await prisma.emailSuppression.upsert({ where: { shopId_email: { shopId: shop.id, email: order.email } }, create: { shopId: shop.id, email: order.email, reason: "HARD_BOUNCE" }, update: {} });
      await setInvitation(id, { status: "FAILED", attempts, lastError: e.message.slice(0, 500) });
      await evaluateOrder(order.id); // → CANCELLED (unzustellbar)
      return false;
    }
    if (!e.permanent && attempts < MAX_SEND_RETRIES) {
      // Exponentielles Backoff: 5, 20, 80 Minuten
      await setInvitation(id, { status: "SCHEDULED", attempts, lastError: e.message.slice(0, 500), scheduledAt: new Date(Date.now() + 5 * 60_000 * 4 ** (attempts - 1)) });
    } else {
      await setInvitation(id, { status: "FAILED", attempts, lastError: e.message.slice(0, 500) });
    }
    return false;
  }
}

async function judgemePlatformId(shopId: string): Promise<string | null> {
  return (await db().reviewPlatform.findUnique({ where: { shopId_key: { shopId, key: "JUDGEME" } }, select: { id: true } }))?.id ?? null;
}

/** Hängengebliebene "SENDING"-Einladungen (z. B. nach Neustart) – NICHT erneut senden, sondern prüfen lassen */
export async function recoverStuckSending(olderThanMinutes = 15): Promise<number> {
  const res = await db().reviewInvitation.updateMany({
    where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - olderThanMinutes * 60_000) } },
    data: { status: "FAILED", lastError: "Versandstatus unklar (Abbruch während des Versands) – bitte manuell prüfen, wird nicht automatisch wiederholt" },
  });
  return res.count;
}
