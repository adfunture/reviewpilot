import { db } from "../src/lib/db.js";
import { ensureShop } from "../src/services/bootstrap.js";
import type { NormalizedOrder } from "../src/shopify/mapper.js";
import { upsertOrder } from "../src/shopify/sync.js";

const TABLES = [
  "email_events", "review_events", "review_invitations", "review_campaigns", "tracking_events", "fulfillments", "order_items",
  "attribution_sources", "orders", "customers", "consent_records", "email_suppressions", "webhook_events", "audit_logs", "jobs",
  "email_templates", "review_platforms", "review_rules", "channel_mapping_rules", "shop_integrations", "users", "shops",
];

export async function resetDb(): Promise<void> {
  await db().$executeRawUnsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
}

/** Shop mit aktiver Google-Plattform, Rechtsgrundlage § 7 Abs. 3 UWG und freigegebenem Versand */
export async function setupShop(domain = "test-shop.myshopify.com", opts: { released?: boolean } = {}): Promise<string> {
  const shopId = await ensureShop(domain, "Adfunture Test");
  await db().reviewRule.update({ where: { shopId }, data: { legalBasis: "UWG_7_3", sendingEnabled: opts.released ?? true, considerJudgemeInvitations: false } });
  await db().reviewPlatform.update({ where: { shopId_key: { shopId, key: "GOOGLE_BUSINESS" } }, data: { active: true, reviewUrl: "https://g.page/r/test/review", targetShare: 100 } });
  return shopId;
}

let counter = 0;

export interface OrderOpts {
  createdAt?: string;
  updatedAt?: string;
  email?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  shippingMethod?: string;
  shipped?: boolean;
  shippedAt?: string;
  deliveredAt?: string | null;
  displayStatus?: string;
  fulfillmentStatus?: string;
  cancelledAt?: string | null;
  refunded?: number;
  utmSource?: string | null;
  marketingState?: string;
  id?: string;
}

export function makeOrder(o: OrderOpts = {}): NormalizedOrder {
  counter++;
  const id = o.id ?? `gid://shopify/Order/${1000 + counter}`;
  const shipped = o.shipped ?? true;
  const email = o.email === undefined ? `kunde${counter}@example.test` : o.email;
  return {
    shopifyOrderId: id,
    name: `#${1000 + counter}`,
    orderNumber: 1000 + counter,
    orderCreatedAt: new Date(o.createdAt ?? "2026-12-01T10:00:00+01:00"),
    shopifyUpdatedAt: new Date(o.updatedAt ?? o.createdAt ?? "2026-12-01T10:00:00+01:00"),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    isTest: false,
    email,
    firstName: "Anna",
    lastName: "Muster",
    locale: "de-DE",
    totalPrice: 100,
    totalRefunded: o.refunded ?? 0,
    currency: "EUR",
    financialStatus: "PAID",
    fulfillmentStatus: o.fulfillmentStatus ?? (shipped ? "FULFILLED" : "UNFULFILLED"),
    returnStatus: "NO_RETURN",
    sourceName: "web",
    acceptsMarketing: false,
    shippingMethod: o.shippingMethod ?? "Versand",
    customer: { shopifyCustomerId: `gid://shopify/Customer/${counter}`, email, firstName: "Anna", lastName: "Muster", marketingState: o.marketingState ?? "NOT_SUBSCRIBED" },
    items: [{ shopifyLineItemId: `gid://shopify/LineItem/${counter}`, title: "Thule Dachbox", sku: "TH-1", quantity: 1, shopifyProductId: null, unitPrice: 100 }],
    fulfillments: shipped
      ? [
          {
            shopifyFulfillmentId: `gid://shopify/Fulfillment/${counter}`,
            status: "SUCCESS",
            displayStatus: o.displayStatus ?? (o.deliveredAt ? "DELIVERED" : "FULFILLED"),
            carrier: o.carrier === undefined ? "DHL" : o.carrier,
            trackingNumber: o.trackingNumber === undefined ? "00340434161094012345" : o.trackingNumber,
            trackingUrl: null,
            shippedAt: new Date(o.shippedAt ?? "2026-12-01T15:00:00+01:00"),
            inTransitAt: null,
            deliveredAt: o.deliveredAt ? new Date(o.deliveredAt) : null,
            estimatedDeliveryAt: null,
            events: o.deliveredAt ? [{ externalId: `gid://shopify/FulfillmentEvent/${counter}`, status: "DELIVERED", happenedAt: new Date(o.deliveredAt), message: null }] : [],
          },
        ]
      : [],
    attribution: { sourceName: "web", referrerUrl: null, landingPage: null, utmSource: o.utmSource ?? null, utmMedium: null, utmCampaign: null, visitSource: null, raw: null },
  };
}

export async function addOrder(shopId: string, o: OrderOpts = {}): Promise<string> {
  return upsertOrder(shopId, makeOrder(o));
}

export async function invitations(orderId: string) {
  return db().reviewInvitation.findMany({ where: { campaign: { orderId } }, orderBy: { step: "asc" } });
}

export async function campaign(orderId: string) {
  return db().reviewCampaign.findUnique({ where: { orderId } });
}
