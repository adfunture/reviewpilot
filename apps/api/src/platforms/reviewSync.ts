import { markReviewReceived } from "../campaigns/engine.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { fetchReviews, loadJudgemeConfig } from "./judgeme.js";

/**
 * Holt die neuesten Judge.me-Bewertungen (dokumentierter Reviews-Endpunkt), speichert sie als bestätigte
 * Bewertungen und beendet offene ReviewPilot-Kampagnen derselben Kunden, wenn „Judge.me berücksichtigen“ aktiv ist.
 * Ohne erfolgreich getestete Verbindung passiert nichts (keine vorgetäuschte Synchronisierung).
 */
export async function syncJudgemeReviews(shopId: string, fetchImpl: typeof fetch = fetch, pages = 3): Promise<number> {
  const cfg = await loadJudgemeConfig(shopId);
  if (!cfg) return 0;
  const platform = await db().reviewPlatform.findUnique({ where: { shopId_key: { shopId, key: "JUDGEME" } } });
  const rule = await db().reviewRule.findUnique({ where: { shopId } });
  let stored = 0;
  for (let page = 1; page <= pages; page++) {
    const reviews = await fetchReviews(cfg, { page: String(page) }, fetchImpl);
    if (!reviews.length) break;
    for (const r of reviews) {
      const email = r.reviewer?.email?.toLowerCase();
      const createdAt = new Date(r.created_at);
      const order = email
        ? await db().order.findFirst({ where: { shopId, email, orderCreatedAt: { lte: createdAt } }, orderBy: { orderCreatedAt: "desc" }, include: { campaign: true } })
        : null;
      const existing = await db().reviewEvent.findFirst({ where: { shopId, platformId: platform?.id ?? null, externalId: String(r.id) } });
      if (!existing) {
        await db().reviewEvent.create({
          data: { shopId, platformId: platform?.id ?? null, orderId: order?.id, campaignId: order?.campaign?.id, type: "REVIEW_CONFIRMED", externalId: String(r.id), rating: r.rating, occurredAt: createdAt },
        });
        stored++;
      }
      const c = order?.campaign;
      if (c && rule?.considerJudgemeInvitations && ["PENDING", "SCHEDULED", "ACTIVE", "PAUSED"].includes(c.status)) {
        await markReviewReceived(c.id, "Judge.me-Bewertung vorhanden");
      }
    }
  }
  if (stored) logger.info({ shopId, stored }, "Judge.me-Bewertungen übernommen");
  return stored;
}
