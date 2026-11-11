import { Prisma } from "@prisma/client";
import { detectChannel, type MappingRule } from "../domain/attribution.js";
import { deriveDelivery } from "../domain/delivery.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import type { ShopifyClient } from "./client.js";
import { normalizeOrder, type NormalizedOrder } from "./mapper.js";
import { ORDER_BY_ID, ORDERS_PAGE, type ShopifyOrder } from "./queries.js";

/** Speichert eine Bestellung idempotent (Upsert über shopId + Shopify-ID) und leitet Zustellstatus und Kanal ab. */
export async function upsertOrder(shopId: string, o: NormalizedOrder): Promise<string> {
  const prisma = db();
  const rule = await prisma.reviewRule.findUnique({ where: { shopId } });
  const mappings = (await prisma.channelMappingRule.findMany({ where: { shopId, active: true } })) as MappingRule[];

  return prisma.$transaction(async (tx) => {
    const existing = await tx.order.findUnique({ where: { shopId_shopifyOrderId: { shopId, shopifyOrderId: o.shopifyOrderId } }, select: { id: true, shopifyUpdatedAt: true } });
    // Veraltete Daten (z. B. verspäteter Webhook) nicht über neuere schreiben
    if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt > o.shopifyUpdatedAt) return existing.id;

    let customerId: string | null = null;
    if (o.customer) {
      const c = await tx.customer.upsert({
        where: { shopId_shopifyCustomerId: { shopId, shopifyCustomerId: o.customer.shopifyCustomerId } },
        create: { shopId, ...o.customer, locale: o.locale },
        update: { email: o.customer.email, firstName: o.customer.firstName, lastName: o.customer.lastName, marketingState: o.customer.marketingState, locale: o.locale },
      });
      customerId = c.id;
    }

    const channel = detectChannel(o.attribution, mappings.length ? mappings : undefined);
    const orderData = {
      name: o.name,
      orderNumber: o.orderNumber,
      orderCreatedAt: o.orderCreatedAt,
      shopifyUpdatedAt: o.shopifyUpdatedAt,
      customerId,
      email: o.email?.trim().toLowerCase() ?? null,
      firstName: o.firstName,
      lastName: o.lastName,
      locale: o.locale,
      totalPrice: new Prisma.Decimal(o.totalPrice),
      totalRefunded: new Prisma.Decimal(o.totalRefunded),
      currency: o.currency,
      financialStatus: o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus,
      returnStatus: o.returnStatus,
      cancelledAt: o.cancelledAt,
      sourceName: o.sourceName,
      shippingMethod: o.shippingMethod,
      isTest: o.isTest,
      acceptsMarketing: o.acceptsMarketing,
      channel: channel.channel,
      channelMethod: channel.method,
      channelConfidence: channel.confidence,
    };
    const order = await tx.order.upsert({
      where: { shopId_shopifyOrderId: { shopId, shopifyOrderId: o.shopifyOrderId } },
      create: { shopId, shopifyOrderId: o.shopifyOrderId, ...orderData },
      update: orderData,
    });

    for (const item of o.items) {
      const data = { title: item.title, sku: item.sku, quantity: item.quantity, shopifyProductId: item.shopifyProductId, unitPrice: item.unitPrice == null ? null : new Prisma.Decimal(item.unitPrice) };
      await tx.orderItem.upsert({
        where: { orderId_shopifyLineItemId: { orderId: order.id, shopifyLineItemId: item.shopifyLineItemId } },
        create: { orderId: order.id, shopifyLineItemId: item.shopifyLineItemId, ...data },
        update: data,
      });
    }

    for (const f of o.fulfillments) {
      const data = {
        status: f.status,
        displayStatus: f.displayStatus,
        carrier: f.carrier,
        trackingNumber: f.trackingNumber,
        trackingUrl: f.trackingUrl,
        shippedAt: f.shippedAt,
        inTransitAt: f.inTransitAt,
        deliveredAt: f.deliveredAt,
        estimatedDeliveryAt: f.estimatedDeliveryAt,
      };
      const row = await tx.fulfillment.upsert({
        where: { orderId_shopifyFulfillmentId: { orderId: order.id, shopifyFulfillmentId: f.shopifyFulfillmentId } },
        create: { orderId: order.id, shopifyFulfillmentId: f.shopifyFulfillmentId, ...data },
        update: data,
      });
      for (const e of f.events) {
        await tx.trackingEvent.upsert({
          where: { fulfillmentId_externalId: { fulfillmentId: row.id, externalId: e.externalId } },
          create: { fulfillmentId: row.id, externalId: e.externalId, source: "SHOPIFY", status: e.status, happenedAt: e.happenedAt, message: e.message },
          update: { status: e.status, happenedAt: e.happenedAt, message: e.message },
        });
      }
    }

    await tx.attributionSource.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, ...o.attribution, raw: (o.attribution.raw ?? undefined) as Prisma.InputJsonValue | undefined },
      update: { ...o.attribution, raw: (o.attribution.raw ?? undefined) as Prisma.InputJsonValue | undefined },
    });

    // Einwilligungsinformation aus Shopify protokollieren (nur Zustandswechsel)
    if (o.email && o.customer?.marketingState) {
      const last = await tx.consentRecord.findFirst({ where: { shopId, email: o.email, source: "shopify_marketing_state" }, orderBy: { recordedAt: "desc" } });
      const status = o.customer.marketingState === "SUBSCRIBED" ? "GRANTED" : o.customer.marketingState === "UNSUBSCRIBED" ? "REVOKED" : null;
      if (status && last?.status !== status) {
        await tx.consentRecord.create({ data: { shopId, email: o.email, status, source: "shopify_marketing_state", detail: o.customer.marketingState } });
      }
    }

    await recomputeDelivery(tx, order.id, rule?.freightPatterns ?? []);
    return order.id;
  });
}

/** Zustellstatus aus Fulfillments + Tracking-Events (inkl. manueller Bestätigung) neu berechnen */
export async function recomputeDelivery(tx: Prisma.TransactionClient, orderId: string, freightPatterns: string[]): Promise<void> {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { fulfillments: { include: { trackingEvents: true } } } });
  const result = deriveDelivery(
    {
      cancelledAt: order.cancelledAt,
      fulfillmentStatus: order.fulfillmentStatus,
      returnStatus: order.returnStatus,
      shippingMethod: order.shippingMethod,
      fulfillments: order.fulfillments.map((f) => ({
        status: f.status,
        displayStatus: f.displayStatus,
        carrier: f.carrier,
        trackingNumber: f.trackingNumber,
        shippedAt: f.shippedAt,
        deliveredAt: f.deliveredAt,
        events: f.trackingEvents.map((e) => ({ status: e.status, happenedAt: e.happenedAt, source: e.source })),
      })),
    },
    freightPatterns,
  );
  await tx.order.update({
    where: { id: orderId },
    data: {
      deliveryStatus: result.status,
      deliverySource: result.source,
      shippedAt: result.shippedAt,
      deliveredAt: result.deliveredAt,
      hasTracking: result.hasTracking,
      carrier: result.carrier,
      isFreight: result.isFreight,
    },
  });
}

/** Lädt eine Bestellung vollständig per GraphQL nach (Webhooks enthalten u. a. keine Attribution) */
export async function fetchAndUpsertOrder(client: ShopifyClient, shopId: string, orderGid: string): Promise<string | null> {
  const data = await client.graphql<{ order: ShopifyOrder | null }>(ORDER_BY_ID, { id: orderGid });
  if (!data.order) return null;
  return upsertOrder(shopId, normalizeOrder(data.order));
}

/**
 * Erstimport bzw. inkrementeller Sync. Ohne `since`: letzte `initialDays` Tage (Erstimport).
 * Gibt die IDs der geänderten Bestellungen zurück.
 */
export async function syncOrders(client: ShopifyClient, shopId: string, opts: { since?: Date; initialDays?: number } = {}): Promise<string[]> {
  const since = opts.since ?? new Date(Date.now() - (opts.initialDays ?? 60) * 86400_000);
  const query = `updated_at:>='${since.toISOString()}'`;
  const ids: string[] = [];
  let after: string | null = null;
  const startedAt = new Date();
  for (;;) {
    const page: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyOrder[] } } = await client.graphql(ORDERS_PAGE, { first: 50, after, query });
    for (const node of page.orders.nodes) {
      try {
        ids.push(await upsertOrder(shopId, normalizeOrder(node)));
      } catch (err) {
        logger.error({ err, order: node.name }, "Bestellung konnte nicht gespeichert werden");
      }
    }
    if (!page.orders.pageInfo.hasNextPage) break;
    after = page.orders.pageInfo.endCursor;
  }
  // 5 Minuten Überlappung beim nächsten Lauf, damit nichts verloren geht
  await db().shop.update({ where: { id: shopId }, data: { lastOrderSyncAt: new Date(startedAt.getTime() - 5 * 60_000) } });
  return ids;
}
