import type { ShopifyOrder, Visit } from "./queries.js";

/** Normalisierte Bestellung, unabhängig davon, ob sie aus GraphQL-Sync oder Webhook-Nachladen stammt */
export interface NormalizedOrder {
  shopifyOrderId: string;
  name: string;
  orderNumber: number | null;
  orderCreatedAt: Date;
  shopifyUpdatedAt: Date;
  cancelledAt: Date | null;
  isTest: boolean;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  locale: string | null;
  totalPrice: number;
  totalRefunded: number;
  currency: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  sourceName: string | null;
  acceptsMarketing: boolean;
  shippingMethod: string | null;
  customer: { shopifyCustomerId: string; email: string | null; firstName: string | null; lastName: string | null; marketingState: string | null } | null;
  items: { shopifyLineItemId: string; title: string; sku: string | null; quantity: number; shopifyProductId: string | null; unitPrice: number | null }[];
  fulfillments: {
    shopifyFulfillmentId: string;
    status: string;
    displayStatus: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: Date;
    inTransitAt: Date | null;
    deliveredAt: Date | null;
    estimatedDeliveryAt: Date | null;
    events: { externalId: string; status: string; happenedAt: Date; message: string | null }[];
  }[];
  attribution: {
    sourceName: string | null;
    referrerUrl: string | null;
    landingPage: string | null;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    visitSource: string | null;
    raw: unknown;
  };
}

const d = (s: string | null | undefined) => (s ? new Date(s) : null);

function trackingNumberFrom(info: { number: string | null; url: string | null }): string | null {
  if (info.number) return info.number;
  // Manche Carrier-Integrationen (z. B. Deutsche Post) liefern die Nummer nur in der URL
  if (!info.url) return null;
  try {
    const u = new URL(info.url);
    for (const key of ["form.sendungsnummer", "piececode", "idc", "match", "tracking_number", "trackingNumber"]) {
      const v = u.searchParams.get(key);
      if (v) return v;
    }
  } catch {
    /* ungültige URL */
  }
  return null;
}

export function normalizeOrder(o: ShopifyOrder): NormalizedOrder {
  // Für die Kanalerkennung zählt der Besuch, der zur Bestellung geführt hat (lastVisit), Fallback firstVisit
  const visit: Visit | null = o.customerJourneySummary?.lastVisit ?? o.customerJourneySummary?.firstVisit ?? null;
  const email = o.customer?.defaultEmailAddress?.emailAddress ?? o.email ?? null;
  return {
    shopifyOrderId: o.id,
    name: o.name,
    orderNumber: o.number ?? null,
    orderCreatedAt: new Date(o.createdAt),
    shopifyUpdatedAt: new Date(o.updatedAt),
    cancelledAt: d(o.cancelledAt),
    isTest: o.test,
    email: email?.toLowerCase() ?? null,
    firstName: o.customer?.firstName ?? null,
    lastName: o.customer?.lastName ?? null,
    locale: o.customerLocale,
    totalPrice: Number(o.totalPriceSet.shopMoney.amount),
    totalRefunded: Number(o.totalRefundedSet.shopMoney.amount),
    currency: o.totalPriceSet.shopMoney.currencyCode ?? "EUR",
    financialStatus: o.displayFinancialStatus,
    fulfillmentStatus: o.displayFulfillmentStatus,
    returnStatus: o.returnStatus,
    sourceName: o.sourceName,
    acceptsMarketing: o.customerAcceptsMarketing,
    shippingMethod: o.shippingLine?.title ?? null,
    customer: o.customer
      ? {
          shopifyCustomerId: o.customer.id,
          email: o.customer.defaultEmailAddress?.emailAddress?.toLowerCase() ?? null,
          firstName: o.customer.firstName,
          lastName: o.customer.lastName,
          marketingState: o.customer.defaultEmailAddress?.marketingState ?? null,
        }
      : null,
    items: o.lineItems.nodes.map((li) => ({
      shopifyLineItemId: li.id,
      title: li.title,
      sku: li.sku,
      quantity: li.quantity,
      shopifyProductId: li.product?.id ?? null,
      unitPrice: li.originalUnitPriceSet ? Number(li.originalUnitPriceSet.shopMoney.amount) : null,
    })),
    fulfillments: o.fulfillments.map((f) => {
      const t = f.trackingInfo[0] ?? { company: null, number: null, url: null };
      return {
        shopifyFulfillmentId: f.id,
        status: f.status,
        displayStatus: f.displayStatus,
        carrier: t.company,
        trackingNumber: trackingNumberFrom(t),
        trackingUrl: t.url,
        shippedAt: new Date(f.createdAt),
        inTransitAt: d(f.inTransitAt),
        deliveredAt: d(f.deliveredAt),
        estimatedDeliveryAt: d(f.estimatedDeliveryAt),
        events: f.events.nodes.map((e) => ({ externalId: e.id, status: e.status, happenedAt: new Date(e.happenedAt), message: e.message })),
      };
    }),
    attribution: {
      sourceName: o.sourceName,
      referrerUrl: visit?.referrerUrl ?? null,
      landingPage: visit?.landingPage ?? null,
      utmSource: visit?.utmParameters?.source ?? null,
      utmMedium: visit?.utmParameters?.medium ?? null,
      utmCampaign: visit?.utmParameters?.campaign ?? null,
      visitSource: visit?.source ?? null,
      raw: o.customerJourneySummary ?? null,
    },
  };
}
