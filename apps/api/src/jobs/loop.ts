import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { handlers, scheduleRecurring } from "./handlers.js";
import { releaseStale, runOnce } from "./queue.js";

let stopping = false;

/** Worker-Schleife: plant wiederkehrende Jobs und arbeitet die Queue ab. Mehrere Instanzen sind sicher. */
export async function startWorker(): Promise<void> {
  const c = config();
  const id = `worker-${randomUUID().slice(0, 8)}`;
  const shopifyConfigured = !!(c.SHOPIFY_SHOP_DOMAIN && c.SHOPIFY_CLIENT_ID && c.SHOPIFY_CLIENT_SECRET);
  logger.info({ id, shopifyConfigured, emailTransport: c.EMAIL_TRANSPORT, allowCustomerEmails: c.ALLOW_CUSTOMER_EMAILS }, "Worker gestartet");
  await releaseStale(); // nach Neustart: abgebrochene Jobs (älter als 15 min) freigeben
  while (!stopping) {
    try {
      await scheduleRecurring(new Date(), shopifyConfigured);
      let worked = 0;
      while (!stopping && worked < 50 && (await runOnce(handlers, id))) worked++;
    } catch (err) {
      logger.error({ err }, "Worker-Schleife fehlgeschlagen");
    }
    await new Promise((r) => setTimeout(r, c.WORKER_POLL_MS));
  }
}

export function stopWorker(): void {
  stopping = true;
}

