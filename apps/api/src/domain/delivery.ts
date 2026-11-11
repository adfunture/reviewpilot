import type { DeliverySource, DeliveryStatus } from "@prisma/client";

export interface FulfillmentInput {
  status: string; // Shopify FulfillmentStatus: SUCCESS | CANCELLED | ERROR | FAILURE | OPEN | PENDING
  displayStatus?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  shippedAt: Date;
  deliveredAt?: Date | null;
  events: { status: string; happenedAt: Date; source: DeliverySource }[];
}

export interface OrderDeliveryInput {
  cancelledAt?: Date | null;
  fulfillmentStatus?: string | null; // Shopify OrderDisplayFulfillmentStatus
  returnStatus?: string | null; // Shopify OrderReturnStatus
  shippingMethod?: string | null;
  fulfillments: FulfillmentInput[];
}

export interface DeliveryResult {
  status: DeliveryStatus;
  source: DeliverySource | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  hasTracking: boolean;
  carrier: string | null;
  isFreight: boolean;
  fullyShipped: boolean;
}

const FAILED = new Set(["FAILURE", "NOT_DELIVERED"]);
const DELAYED = new Set(["DELAYED", "ATTEMPTED_DELIVERY"]);
const IN_TRANSIT = new Set(["IN_TRANSIT", "OUT_FOR_DELIVERY", "CARRIER_PICKED_UP", "PICKED_UP", "READY_FOR_PICKUP"]);
const RETURN_ACTIVE = new Set(["RETURN_REQUESTED", "IN_PROGRESS", "RETURNED", "INSPECTION_COMPLETE"]);

export function isFreight(carrier: string | null | undefined, shippingMethod: string | null | undefined, patterns: string[]): boolean {
  const hay = `${carrier ?? ""} ${shippingMethod ?? ""}`.toLowerCase();
  return patterns.some((p) => p && hay.includes(p.toLowerCase()));
}

function deliveredAtOf(f: FulfillmentInput): Date | null {
  // Nur echte Zustellsignale: Shopify-deliveredAt, displayStatus DELIVERED (mit Event-Zeit) oder ein DELIVERED-Event (Shopify/Carrier/manuell)
  const ev = f.events.filter((e) => e.status === "DELIVERED").sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime())[0];
  if (f.deliveredAt) return f.deliveredAt;
  if (ev) return ev.happenedAt;
  return null;
}

/**
 * Leitet den Zustellstatus her. Grundsatz: Eine Versandbestätigung ist KEINE Zustellbestätigung.
 * "DELIVERED" nur bei echtem Zustellsignal je Sendung.
 */
export function deriveDelivery(order: OrderDeliveryInput, freightPatterns: string[]): DeliveryResult {
  const active = order.fulfillments.filter((f) => f.status === "SUCCESS");
  const carrier = active.find((f) => f.carrier)?.carrier ?? null;
  const hasTracking = active.some((f) => !!f.trackingNumber);
  const freight = isFreight(carrier, order.shippingMethod, freightPatterns);
  const shippedAt = active.length ? new Date(Math.min(...active.map((f) => f.shippedAt.getTime()))) : null;
  const fullyShipped = active.length > 0 && (order.fulfillmentStatus == null || order.fulfillmentStatus === "FULFILLED");
  const base = { shippedAt, hasTracking, carrier, isFreight: freight, fullyShipped, deliveredAt: null, source: null };

  if (order.cancelledAt) return { ...base, status: "CANCELLED" };
  if (order.returnStatus && RETURN_ACTIVE.has(order.returnStatus)) return { ...base, status: "RETURNED" };
  if (active.length === 0) {
    return { ...base, status: order.fulfillmentStatus === "IN_PROGRESS" ? "PROCESSING" : order.fulfillmentStatus ? "PROCESSING" : "ORDER_RECEIVED" };
  }

  const displays = active.map((f) => f.displayStatus ?? "");
  const latestEvent = (f: FulfillmentInput) => [...f.events].sort((a, b) => b.happenedAt.getTime() - a.happenedAt.getTime())[0]?.status ?? "";

  if (active.some((f) => FAILED.has(f.displayStatus ?? "") || FAILED.has(latestEvent(f)))) return { ...base, status: "FAILED" };

  const deliveredDates = active.map(deliveredAtOf);
  if (fullyShipped && deliveredDates.every((d): d is Date => d !== null)) {
    const manual = active.some((f) => f.events.some((e) => e.status === "DELIVERED" && e.source === "MANUAL")) && !active.some((f) => f.deliveredAt);
    const deliveredAt = new Date(Math.max(...deliveredDates.map((d) => d.getTime())));
    const source: DeliverySource = manual ? "MANUAL" : active.some((f) => f.events.some((e) => e.source === "CARRIER_API" && e.status === "DELIVERED")) ? "CARRIER_API" : "SHOPIFY";
    return { ...base, status: "DELIVERED", deliveredAt, source };
  }

  if (displays.some((d) => DELAYED.has(d)) || active.some((f) => DELAYED.has(latestEvent(f)))) return { ...base, status: "DELAYED" };
  if (!hasTracking || freight) return { ...base, status: "DELIVERY_UNKNOWN" };
  if (displays.some((d) => IN_TRANSIT.has(d)) || active.some((f) => IN_TRANSIT.has(latestEvent(f)))) return { ...base, status: "IN_TRANSIT" };
  return { ...base, status: "SHIPPED" };
}
