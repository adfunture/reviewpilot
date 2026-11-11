import { db } from "../lib/db.js";

export interface Range {
  from: Date;
  to: Date;
}

/** Alle Kennzahlen kommen aus echten Datensätzen. Nicht verfügbare Werte sind null (nie geschätzt). */
export async function dashboardStats(shopId: string, r: Range) {
  const prisma = db();
  const orderWhere = { shopId, isTest: false, orderCreatedAt: { gte: r.from, lte: r.to } };
  const [orders, delivered, noTracking, scheduled, sentInvites, failedInvites, bounces, clicked, reviews, ratingAgg, statusGroups] = await Promise.all([
    prisma.order.count({ where: orderWhere }),
    prisma.order.count({ where: { ...orderWhere, deliveryStatus: "DELIVERED" } }),
    prisma.order.count({ where: { ...orderWhere, shippedAt: { not: null }, OR: [{ hasTracking: false }, { isFreight: true }] } }),
    prisma.reviewInvitation.count({ where: { status: "SCHEDULED", campaign: { shopId } } }),
    prisma.reviewInvitation.count({ where: { status: "SENT", sentAt: { gte: r.from, lte: r.to }, campaign: { shopId } } }),
    prisma.reviewInvitation.count({ where: { status: "FAILED", updatedAt: { gte: r.from, lte: r.to }, campaign: { shopId } } }),
    prisma.emailEvent.count({ where: { shopId, type: "BOUNCED_HARD", occurredAt: { gte: r.from, lte: r.to } } }),
    prisma.reviewInvitation.count({ where: { status: "SENT", sentAt: { gte: r.from, lte: r.to }, firstClickedAt: { not: null }, campaign: { shopId } } }),
    prisma.reviewEvent.count({ where: { shopId, type: { in: ["REVIEW_CONFIRMED", "REVIEW_MARKED_MANUALLY"] }, occurredAt: { gte: r.from, lte: r.to } } }),
    prisma.reviewEvent.aggregate({ where: { shopId, type: "REVIEW_CONFIRMED", rating: { not: null }, occurredAt: { gte: r.from, lte: r.to } }, _avg: { rating: true }, _count: { rating: true } }),
    prisma.reviewCampaign.groupBy({ by: ["status"], where: { shopId }, _count: { _all: true } }),
  ]);
  const attempted = sentInvites + failedInvites;
  return {
    orders,
    deliveredOrders: delivered,
    ordersWithoutTracking: noTracking,
    scheduledInvitations: scheduled,
    sentInvitations: sentInvites,
    // Zustellquote = angenommen vom Mailserver abzgl. harter Bounces; ohne Versand: null
    deliveryRate: attempted ? Math.max(0, (sentInvites - bounces) / attempted) : null,
    clickRate: sentInvites ? clicked / sentInvites : null,
    confirmedReviews: reviews,
    averageRating: ratingAgg._count.rating ? ratingAgg._avg.rating : null,
    ratingCount: ratingAgg._count.rating,
    campaignStatus: Object.fromEntries(statusGroups.map((g) => [g.status, g._count._all])),
  };
}

export async function platformStats(shopId: string, r: Range) {
  const prisma = db();
  const platforms = await prisma.reviewPlatform.findMany({ where: { shopId }, orderBy: { priority: "asc" } });
  return Promise.all(
    platforms.map(async (p) => {
      const inv = { campaign: { shopId, platformId: p.id } };
      const [orders, scheduled, sent, bounced, clicks, reviews, rating] = await Promise.all([
        prisma.reviewCampaign.count({ where: { shopId, platformId: p.id, order: { orderCreatedAt: { gte: r.from, lte: r.to } } } }),
        prisma.reviewInvitation.count({ where: { ...inv, status: "SCHEDULED" } }),
        prisma.reviewInvitation.count({ where: { ...inv, status: "SENT", sentAt: { gte: r.from, lte: r.to } } }),
        prisma.emailEvent.count({ where: { shopId, type: "BOUNCED_HARD", occurredAt: { gte: r.from, lte: r.to }, invitation: inv } }),
        prisma.reviewEvent.count({ where: { shopId, platformId: p.id, type: "LINK_CLICKED", occurredAt: { gte: r.from, lte: r.to } } }),
        prisma.reviewEvent.count({ where: { shopId, platformId: p.id, type: { in: ["REVIEW_CONFIRMED", "REVIEW_MARKED_MANUALLY"] }, occurredAt: { gte: r.from, lte: r.to } } }),
        prisma.reviewEvent.aggregate({ where: { shopId, platformId: p.id, type: "REVIEW_CONFIRMED", rating: { not: null }, occurredAt: { gte: r.from, lte: r.to } }, _avg: { rating: true }, _count: { rating: true } }),
      ]);
      return {
        id: p.id,
        key: p.key,
        name: p.name,
        active: p.active,
        integrationType: p.integrationType,
        statusQueryAvailable: p.statusQueryAvailable,
        orders,
        scheduled,
        sent,
        deliveredEmails: Math.max(0, sent - bounced),
        clicks,
        // Bestätigte Bewertungen nur, wenn die Plattform sie liefern kann – sonst null statt 0
        confirmedReviews: p.statusQueryAvailable || reviews > 0 ? reviews : null,
        averageRating: rating._count.rating ? rating._avg.rating : null,
      };
    }),
  );
}

/** Tageswerte für das Diagramm (versendet / Klicks / Bewertungen). Prisma speichert timestamp ohne Zone in UTC. */
export async function dailySeries(shopId: string, r: Range) {
  const rows = await db().$queryRaw<{ day: Date; sent: bigint; clicks: bigint; reviews: bigint }[]>`
    WITH days AS (
      SELECT generate_series(date_trunc('day', ${r.from}::timestamptz AT TIME ZONE 'Europe/Berlin'), date_trunc('day', ${r.to}::timestamptz AT TIME ZONE 'Europe/Berlin'), interval '1 day') AS day
    )
    SELECT d.day,
      (SELECT count(*) FROM review_invitations i JOIN review_campaigns c ON c.id = i.campaign_id
        WHERE c.shop_id = ${shopId}::uuid AND i.status = 'SENT' AND date_trunc('day', (i.sent_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = d.day) AS sent,
      (SELECT count(*) FROM review_events e WHERE e.shop_id = ${shopId}::uuid AND e.type = 'LINK_CLICKED' AND date_trunc('day', (e.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = d.day) AS clicks,
      (SELECT count(*) FROM review_events e WHERE e.shop_id = ${shopId}::uuid AND e.type IN ('REVIEW_CONFIRMED','REVIEW_MARKED_MANUALLY') AND date_trunc('day', (e.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') = d.day) AS reviews
    FROM days d ORDER BY d.day`;
  return rows.map((x) => ({ day: x.day.toISOString().slice(0, 10), sent: Number(x.sent), clicks: Number(x.clicks), reviews: Number(x.reviews) }));
}
