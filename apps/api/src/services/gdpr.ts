import { suppressionHash } from "../campaigns/engine.js";
import { audit, db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/** Aufbewahrungsfristen (Tage) – Datenminimierung */
export const RETENTION = {
  webhookEvents: 30,
  doneJobs: 14,
  emailEvents: 730,
  auditLogs: 1095,
  // Personenbezogene Bestelldaten werden nach Abschluss der Kampagne pseudonymisiert
  orderPersonalData: 365,
};

/** Export aller personenbezogenen Daten zu einer E-Mail-Adresse (Art. 15 DSGVO) */
export async function exportPersonalData(shopId: string, email: string): Promise<unknown> {
  const e = email.toLowerCase();
  const [customers, orders, consents, suppressions] = await Promise.all([
    db().customer.findMany({ where: { shopId, email: e } }),
    db().order.findMany({
      where: { shopId, email: e },
      include: { items: true, attribution: true, campaign: { include: { invitations: { include: { emailEvents: true } } } } },
    }),
    db().consentRecord.findMany({ where: { shopId, email: e } }),
    db().emailSuppression.findMany({ where: { shopId, email: e } }),
  ]);
  return { email: e, exportedAt: new Date().toISOString(), customers, orders, consents, suppressions };
}

/**
 * Löschung (Art. 17 DSGVO): personenbezogene Felder werden entfernt, Kampagnen beendet.
 * Eine bestehende Abmeldung/Widerspruch bleibt als SHA-256-Hash erhalten, damit die Person nie wieder angeschrieben wird.
 */
export async function deletePersonalData(shopId: string, email: string, actor: string): Promise<number> {
  const e = email.toLowerCase();
  const orders = await db().order.findMany({ where: { shopId, email: e }, select: { id: true } });
  await db().$transaction(async (tx) => {
    for (const o of orders) {
      await tx.reviewInvitation.updateMany({ where: { campaign: { orderId: o.id }, status: "SCHEDULED" }, data: { status: "CANCELLED", statusReason: "Daten gelöscht" } });
      await tx.reviewCampaign.updateMany({ where: { orderId: o.id, closedAt: null }, data: { status: "CANCELLED", statusReason: "Daten gelöscht", closedAt: new Date() } });
      await tx.attributionSource.deleteMany({ where: { orderId: o.id } });
    }
    await tx.order.updateMany({ where: { shopId, email: e }, data: { email: null, firstName: null, lastName: null, reviewBlocked: true, reviewBlockedReason: "Daten gelöscht" } });
    await tx.customer.updateMany({ where: { shopId, email: e }, data: { email: null, firstName: null, lastName: null } });
    // Sperre bleibt wirksam, aber nur noch als Hash (Art. 17 DSGVO + Werbewiderspruch beachten)
    const wasSuppressed = (await tx.emailSuppression.count({ where: { shopId, email: e } })) > 0;
    const objected = (await tx.consentRecord.count({ where: { shopId, email: e, status: { in: ["OBJECTED", "REVOKED"] } } })) > 0;
    await tx.emailSuppression.deleteMany({ where: { shopId, email: e } });
    if (wasSuppressed || objected) {
      await tx.emailSuppression.upsert({ where: { shopId_email: { shopId, email: suppressionHash(e) } }, create: { shopId, email: suppressionHash(e), reason: "OBJECTION" }, update: {} });
    }
    await tx.consentRecord.deleteMany({ where: { shopId, email: e } });
  });
  await audit(shopId, actor, "gdpr.delete", "email", undefined, { orders: orders.length });
  return orders.length;
}

export async function runRetention(now = new Date()): Promise<void> {
  const days = (n: number) => new Date(now.getTime() - n * 86400_000);
  const prisma = db();
  const w = await prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: days(RETENTION.webhookEvents) }, status: { in: ["PROCESSED", "IGNORED"] } } });
  const j = await prisma.job.deleteMany({ where: { status: "DONE", finishedAt: { lt: days(RETENTION.doneJobs) } } });
  const ee = await prisma.emailEvent.deleteMany({ where: { occurredAt: { lt: days(RETENTION.emailEvents) } } });
  const a = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: days(RETENTION.auditLogs) } } });
  const o = await prisma.order.updateMany({
    where: { orderCreatedAt: { lt: days(RETENTION.orderPersonalData) }, email: { not: null }, OR: [{ campaign: null }, { campaign: { closedAt: { not: null } } }] },
    data: { email: null, firstName: null, lastName: null },
  });
  logger.info({ webhooks: w.count, jobs: j.count, emailEvents: ee.count, audit: a.count, ordersPseudonymized: o.count }, "Aufbewahrungsfristen angewendet");
}
