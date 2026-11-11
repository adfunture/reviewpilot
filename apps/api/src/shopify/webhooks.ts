import { createHmac } from "node:crypto";
import { safeEqual } from "../lib/crypto.js";

/** Shopify-Webhook-Signatur: base64(HMAC-SHA256(rawBody, clientSecret)) im Header X-Shopify-Hmac-Sha256 */
export function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(digest, hmacHeader);
}

/** Ermittelt die Bestell-GID, die von einem Webhook betroffen ist */
export function orderGidFromWebhook(topic: string, payload: Record<string, unknown>): string | null {
  if (topic.startsWith("orders/")) {
    if (typeof payload.admin_graphql_api_id === "string") return payload.admin_graphql_api_id;
    if (payload.id != null) return `gid://shopify/Order/${payload.id}`;
  }
  if (topic.startsWith("fulfillments/") || topic.startsWith("fulfillment_events/") || topic.startsWith("refunds/")) {
    if (payload.order_id != null) return `gid://shopify/Order/${payload.order_id}`;
  }
  return null;
}
