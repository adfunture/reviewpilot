import { evaluateOrder } from "../campaigns/engine.js";
import { recoverStuckSending, sendDueInvitations } from "../campaigns/sender.js";
import { audit, db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { syncJudgemeReviews } from "../platforms/reviewSync.js";
import { ShopifyClient } from "../shopify/client.js";
import { fetchAndUpsertOrder, syncOrders } from "../shopify/sync.js";
import { orderGidFromWebhook } from "../shopify/webhooks.js";
import { deletePersonalData, runRetention } from "../services/gdpr.js";
import { enqueue, releaseStale, type Handler } from "./queue.js";

let shopifyClient: ShopifyClient | undefined;
export function setShopifyClient(c: ShopifyClient | undefined): void {
  shopifyClient = c;
}
function shopify(): ShopifyClient {
  if (!shopifyClient) shopifyClient = ShopifyClient.fromEnv();
  return shopifyClient;
}

/** Offene Kampagnen und Bestellungen ohne Kampagne (letzte 60 Tage) neu bewerten */
export async function planAll(now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 60 * 86400_000);
  const orders = await db().order.findMany({
    where: {
      orderCreatedAt: { gte: since },
      shop: { uninstalledAt: null },
      OR: [{ campaign: null }, { campaign: { status: { in: ["PENDING", "SCHEDULED", "ACTIVE", "PAUSED", "CONSENT_MISSING"] } } }],
    },
    select: { id: true },
  });
  for (const o of orders) await evaluateOrder(o.id, now);
  return orders.length;
}

export async function processWebhook(webhookEventId: string): Promise<void> {
  const evt = await db().webhookEvent.findUniqueOrThrow({ where: { id: webhookEventId } });
  if (evt.status === "PROCESSED" || evt.status === "IGNORED") return; // idempotent
  const payload = evt.payload as Record<string, unknown>;
  try {
    if (!evt.shopId) throw new Error("Webhook ohne bekannten Shop");
    if (evt.topic === "app/uninstalled" || evt.topic === "shop/redact") {
      await db().shop.update({ where: { id: evt.shopId }, data: { uninstalledAt: new Date() } });
      await db().reviewRule.updateMany({ where: { shopId: evt.shopId }, data: { sendingEnabled: false } });
      await audit(evt.shopId, "webhook", "shop.uninstalled");
    } else if (evt.topic === "customers/redact") {
      const email = (payload.customer as { email?: string } | undefined)?.email;
      if (email) await deletePersonalData(evt.shopId, email, "webhook");
    } else if (evt.topic === "customers/data_request") {
      await audit(evt.shopId, "webhook", "gdpr.data_request", undefined, undefined, { customer: (payload.customer as { id?: number } | undefined)?.id });
    } else {
      const gid = orderGidFromWebhook(evt.topic, payload);
      if (!gid) {
        await db().webhookEvent.update({ where: { id: evt.id }, data: { status: "IGNORED", processedAt: new Date() } });
        return;
      }
      const orderId = await fetchAndUpsertOrder(shopify(), evt.shopId, gid);
      if (orderId) await evaluateOrder(orderId);
    }
    await db().webhookEvent.update({ where: { id: evt.id }, data: { status: "PROCESSED", processedAt: new Date(), error: null } });
  } catch (err) {
    await db().webhookEvent.update({ where: { id: evt.id }, data: { status: "FAILED", error: (err as Error).message.slice(0, 1000) } });
    throw err; // → Retry über die Job-Queue
  }
}

export const handlers: Record<string, Handler> = {
  "process-webhook": async (p) => processWebhook(String(p.webhookEventId)),
  "sync-orders": async (p) => {
    const shops = await db().shop.findMany({ where: { uninstalledAt: null, ...(p.shopId ? { id: String(p.shopId) } : {}) } });
    for (const shop of shops) {
      const ids = await syncOrders(shopify(), shop.id, { since: p.full ? undefined : (shop.lastOrderSyncAt ?? undefined), initialDays: Number(p.initialDays ?? 60) });
      for (const id of ids) await evaluateOrder(id);
      logger.info({ shop: shop.shopifyDomain, orders: ids.length }, "Bestellungen synchronisiert");
    }
  },
  "plan-campaigns": async () => {
    const n = await planAll();
    logger.info({ orders: n }, "Kampagnen neu bewertet");
  },
  "send-due": async () => {
    const n = await sendDueInvitations();
    if (n) logger.info({ sent: n }, "Bewertungseinladungen versendet");
  },
  "recover-stuck": async () => {
    await releaseStale();
    await recoverStuckSending();
  },
  "sync-reviews": async () => {
    const shops = await db().shop.findMany({ where: { uninstalledAt: null } });
    for (const shop of shops) await syncJudgemeReviews(shop.id);
  },
  cleanup: async () => {
    await runRetention();
  },
};

/** Wiederkehrende Aufgaben: Intervall in Minuten. dedupeKey pro Zeitfenster → genau ein Lauf, auch bei mehreren Instanzen. */
export const RECURRING: { type: string; everyMinutes: number }[] = [
  { type: "send-due", everyMinutes: 1 },
  { type: "recover-stuck", everyMinutes: 10 },
  { type: "sync-orders", everyMinutes: 15 },
  { type: "plan-campaigns", everyMinutes: 30 },
  { type: "sync-reviews", everyMinutes: 360 },
  { type: "cleanup", everyMinutes: 1440 },
];

export async function scheduleRecurring(now = new Date(), shopifyConfigured = true): Promise<void> {
  for (const r of RECURRING) {
    if (r.type === "sync-orders" && !shopifyConfigured) continue;
    const slot = Math.floor(now.getTime() / (r.everyMinutes * 60_000));
    await enqueue(r.type, {}, { dedupeKey: `${r.type}:${slot}`, maxAttempts: r.type === "send-due" ? 1 : 3 });
  }
}
