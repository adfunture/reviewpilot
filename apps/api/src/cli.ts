import { randomBytes } from "node:crypto";
import { config, shopifyConfigured } from "./config.js";
import { hashPassword } from "./lib/crypto.js";
import { audit, db, disconnectDb } from "./lib/db.js";
import { ensureShop } from "./services/bootstrap.js";
import { ShopifyClient } from "./shopify/client.js";
import { SHOP_INFO } from "./shopify/queries.js";
import { releaseChecklist } from "./routes/admin.js";
import { reviewUrlProblem } from "./domain/platformLinks.js";

/**
 * Betriebsbefehle:
 *   node dist/cli.js seed                          Shop + Standardkonfiguration anlegen (idempotent)
 *   node dist/cli.js create-admin <email> [OWNER]  Benutzer anlegen, Passwort wird einmalig ausgegeben
 *   node dist/cli.js generate-key                  ENCRYPTION_KEY erzeugen
 *   node dist/cli.js checklist                     Freigabe-Checkliste anzeigen
 *   node dist/cli.js set-review-link <KEY> <URL>   Offiziellen Bewertungslink hinterlegen und Plattform aktivieren
 */
const [cmd, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (cmd) {
    case "generate-key":
      console.log(randomBytes(32).toString("base64"));
      return;
    case "seed": {
      const c = config();
      const domain = c.SHOPIFY_SHOP_DOMAIN;
      if (!domain) throw new Error("SHOPIFY_SHOP_DOMAIN fehlt");
      let name = args[0] ?? "Adfunture";
      if (shopifyConfigured()) {
        try {
          const info = await ShopifyClient.fromEnv().graphql<{ shop: { name: string } }>(SHOP_INFO);
          name = info.shop.name;
        } catch (err) {
          console.warn(`Shopify-Shopname nicht abrufbar (${(err as Error).message}) – verwende "${name}"`);
        }
      }
      const id = await ensureShop(domain, name);
      console.log(`Shop bereit: ${name} (${domain}) – ${id}`);
      return;
    }
    case "create-admin": {
      const [email, role = "OWNER"] = args;
      if (!email) throw new Error("E-Mail fehlt");
      const shop = await db().shop.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
      const password = randomBytes(12).toString("base64url");
      await db().user.upsert({
        where: { email: email.toLowerCase() },
        create: { email: email.toLowerCase(), passwordHash: await hashPassword(password), role: role as "OWNER", shopId: shop.id },
        update: { passwordHash: await hashPassword(password), role: role as "OWNER" },
      });
      await audit(shop.id, "cli", "user.create_or_reset", "user", undefined, { role });
      console.log(`Benutzer ${email} (${role}) – Passwort (nur jetzt sichtbar): ${password}`);
      return;
    }
    case "set-review-link": {
      const [key, url] = args;
      const keys = ["GOOGLE_BUSINESS", "IDEALO", "TRUSTED_SHOPS", "TRUSTPILOT"] as const;
      if (!key || !url || !(keys as readonly string[]).includes(key)) throw new Error(`Aufruf: set-review-link <${keys.join("|")}> <https://…>`);
      const problem = reviewUrlProblem(key as (typeof keys)[number], url);
      if (problem) throw new Error(problem);
      const shop = await db().shop.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
      const p = await db().reviewPlatform.update({ where: { shopId_key: { shopId: shop.id, key: key as (typeof keys)[number] } }, data: { reviewUrl: url, active: true } });
      await audit(shop.id, "cli", "platform.set_review_link", "review_platform", p.id, { key, url });
      console.log(`${p.name}: Link hinterlegt und aktiviert (Anteil ${p.targetShare} %, Erinnerungen ${p.remindersAllowed ? "an" : "aus"})`);
      return;
    }
    case "checklist": {
      const shop = await db().shop.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
      const list = await releaseChecklist(shop.id);
      for (const i of list.items) console.log(`${i.ok ? "✔" : "✘"} ${i.label}${i.blocking ? "" : " (optional)"}`);
      console.log(`\nHinweis: ${list.judgemeWarning}`);
      console.log(`Versand freigegeben: ${list.released ? `ja (${list.releasedBy})` : "nein"}`);
      return;
    }
    default:
      console.log("Befehle: seed | create-admin <email> [OWNER|ADMIN|VIEWER] | generate-key | set-review-link <KEY> <URL> | checklist");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
