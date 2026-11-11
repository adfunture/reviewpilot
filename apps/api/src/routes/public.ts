import type { FastifyInstance } from "fastify";
import { evaluateOrder } from "../campaigns/engine.js";
import { config } from "../config.js";
import { escapeHtml } from "../email/render.js";
import { safeEqual, unsign } from "../lib/crypto.js";
import { audit, db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { enqueue } from "../jobs/queue.js";
import { verifyShopifyHmac } from "../shopify/webhooks.js";

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:520px;margin:64px auto;padding:0 16px;color:#111827}button{background:#111827;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:15px;cursor:pointer}</style></head><body>${body}</body></html>`;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // Klickweiterleitung zum offiziellen Bewertungslink (Klick ≠ Bewertung!)
  app.get<{ Params: { token: string } }>("/r/:token", async (req, reply) => {
    const inv = await db().reviewInvitation.findUnique({ where: { trackingToken: req.params.token }, include: { campaign: { include: { platform: true } } } });
    const url = inv?.campaign.platform?.reviewUrl;
    if (!inv || !url) return reply.code(404).type("text/html").send(page("Link ungültig", "<p>Dieser Link ist nicht mehr gültig.</p>"));
    const first = !inv.firstClickedAt;
    await db().reviewInvitation.update({ where: { id: inv.id }, data: { clickCount: { increment: 1 }, firstClickedAt: inv.firstClickedAt ?? new Date() } });
    if (first) {
      await db().emailEvent.create({ data: { shopId: inv.campaign.shopId, invitationId: inv.id, type: "CLICKED" } });
      await db().reviewEvent.create({
        data: { shopId: inv.campaign.shopId, platformId: inv.campaign.platformId, orderId: inv.campaign.orderId, campaignId: inv.campaignId, type: "LINK_CLICKED", occurredAt: new Date() },
      });
    }
    return reply.redirect(url, 302);
  });

  // Abmeldung: GET zeigt Bestätigung (Schutz vor Link-Scannern), POST führt aus (auch RFC-8058-One-Click)
  app.get<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    const value = unsign(req.params.token, "unsubscribe");
    if (!value) return reply.code(400).type("text/html").send(page("Ungültig", "<p>Dieser Abmeldelink ist ungültig.</p>"));
    return reply
      .type("text/html")
      .send(page("Austragen", `<h1>Keine Bewertungsanfragen mehr</h1><p>Möchtest du keine Bewertungsanfragen mehr von uns erhalten? Ein Klick genügt, du wirst dann dauerhaft ausgetragen.</p><form method="post"><button type="submit">Jetzt austragen</button></form>`));
  });

  app.post<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    const value = unsign(req.params.token, "unsubscribe");
    const [shopId, rawEmail] = value?.split("|") ?? [];
    if (!shopId || !rawEmail) return reply.code(400).type("text/html").send(page("Ungültig", "<p>Dieser Abmeldelink ist ungültig.</p>"));
    const email = rawEmail.trim().toLowerCase();
    await db().emailSuppression.upsert({ where: { shopId_email: { shopId, email } }, create: { shopId, email, reason: "UNSUBSCRIBED" }, update: {} });
    await db().consentRecord.create({ data: { shopId, email, status: "OBJECTED", source: "unsubscribe_link" } });
    const orders = await db().order.findMany({ where: { shopId, email: { equals: email, mode: "insensitive" } }, select: { id: true } });
    for (const o of orders) await evaluateOrder(o.id);
    await audit(shopId, "customer", "email.unsubscribe");
    return reply.type("text/html").send(page("Ausgetragen", "<h1>Du bist ausgetragen</h1><p>Du erhältst von uns keine Bewertungsanfragen mehr – auch nicht bei zukünftigen Bestellungen.</p>"));
  });

  // Shopify-Webhooks: HMAC über Rohdaten prüfen, idempotent speichern (X-Shopify-Webhook-Id), asynchron verarbeiten
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/webhooks/shopify", { config: { rateLimit: false } }, async (req, reply) => {
      const raw = req.body as Buffer;
      const secret = config().SHOPIFY_CLIENT_SECRET ?? "";
      if (!verifyShopifyHmac(raw, req.headers["x-shopify-hmac-sha256"] as string | undefined, secret)) {
        logger.warn({ topic: req.headers["x-shopify-topic"] }, "Webhook mit ungültiger Signatur abgelehnt");
        return reply.code(401).send();
      }
      const webhookId = String(req.headers["x-shopify-webhook-id"] ?? "");
      const topic = String(req.headers["x-shopify-topic"] ?? "");
      const domain = String(req.headers["x-shopify-shop-domain"] ?? "");
      if (!webhookId || !topic) return reply.code(400).send();
      const shop = await db().shop.findUnique({ where: { shopifyDomain: domain } });
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send();
      }
      try {
        const evt = await db().webhookEvent.create({
          data: { webhookId, eventId: (req.headers["x-shopify-event-id"] as string | undefined) ?? null, topic, shopId: shop?.id ?? null, payload: payload as object },
        });
        await enqueue("process-webhook", { webhookEventId: evt.id }, { dedupeKey: `webhook:${webhookId}`, maxAttempts: 8 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "P2002") throw err; // Duplikat → bereits angenommen
      }
      return reply.code(200).send();
    });

    // Generischer Bounce-Webhook für E-Mail-Provider (z. B. Postmark/Brevo per Weiterleitung): {email, type: hard|soft|complaint}
    scope.post("/webhooks/email-bounce", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      const secret = process.env.BOUNCE_WEBHOOK_SECRET;
      const given = String(req.headers["x-reviewpilot-secret"] ?? "");
      if (!secret || !safeEqual(given, secret)) return reply.code(401).send();
      const body = JSON.parse((req.body as Buffer).toString("utf8")) as { shopDomain?: string; email?: string; type?: string };
      const shop = body.shopDomain ? await db().shop.findUnique({ where: { shopifyDomain: body.shopDomain } }) : await db().shop.findFirst();
      if (!shop || !body.email) return reply.code(400).send();
      const email = body.email.toLowerCase();
      if (body.type === "hard" || body.type === "complaint") {
        await db().emailSuppression.upsert({
          where: { shopId_email: { shopId: shop.id, email } },
          create: { shopId: shop.id, email, reason: body.type === "hard" ? "HARD_BOUNCE" : "COMPLAINT" },
          update: {},
        });
        const orders = await db().order.findMany({ where: { shopId: shop.id, email }, select: { id: true } });
        for (const o of orders) await evaluateOrder(o.id);
      }
      await db().emailEvent.create({ data: { shopId: shop.id, type: body.type === "soft" ? "BOUNCED_SOFT" : "BOUNCED_HARD", detail: body.type ?? null } });
      return { ok: true };
    });
  });
}
