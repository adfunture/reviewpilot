import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  // Öffentliche Basis-URL (für Klick-/Abmeldelinks in E-Mails), z. B. https://reviews.adfunture.de
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  // 32 Byte, base64 – verschlüsselt Integrations-Zugangsdaten (AES-256-GCM)
  ENCRYPTION_KEY: z.string().optional(),
  // Signiert Session-Cookies und Abmelde-Links
  SESSION_SECRET: z.string().min(32).optional(),
  COOKIE_SECURE: bool,

  // Shopify (Dev-Dashboard-App, Client Credentials Grant für den eigenen Shop)
  SHOPIFY_SHOP_DOMAIN: z.string().optional(), // adfunture.myshopify.com
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(), // auch: „API-Geheimschlüssel“ einer im Admin erstellten App (Webhook-Signatur)
  // Alternative zum Client Credentials Grant: festes Admin-API-Zugriffstoken (shpat_…) einer im Shopify-Admin
  // erstellten Custom App. Ist es gesetzt, wird kein Token angefragt.
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2026-10"),

  // E-Mail
  EMAIL_TRANSPORT: z.enum(["smtp", "log"]).default("log"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().optional(), // "Adfunture <bewertung@adfunture.de>"
  EMAIL_REPLY_TO: z.string().optional(),
  // Zweite, harte Sicherung neben der Freigabe im Dashboard: ohne "true" verlässt keine Kunden-E-Mail das System
  ALLOW_CUSTOMER_EMAILS: bool,
  // Versanddrosselung: max. SEND_BATCH_SIZE Mails pro Durchgang, SEND_STAGGER_SECONDS Abstand zwischen den Mails
  // eines Durchgangs, mind. SEND_BATCH_INTERVAL_MINUTES zwischen zwei Durchgängen (schont Absender-Reputation)
  SEND_BATCH_SIZE: z.coerce.number().int().min(1).default(5),
  SEND_STAGGER_SECONDS: z.coerce.number().int().min(0).default(30),
  SEND_BATCH_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(10),

  // Worker
  RUN_WORKER_IN_WEB: bool, // spart einen Railway-Service (kleine Shops)
  WORKER_POLL_MS: z.coerce.number().int().default(5000),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`Ungültige Umgebungsvariablen: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    cached = parsed.data;
    if (cached.NODE_ENV === "production") {
      for (const key of ["ENCRYPTION_KEY", "SESSION_SECRET"] as const) {
        if (!cached[key]) throw new Error(`${key} muss in Produktion gesetzt sein`);
      }
    }
  }
  return cached;
}

/** Nur für Tests */
export function resetConfig(): void {
  cached = undefined;
}

export function sessionSecret(): string {
  const c = config();
  if (c.SESSION_SECRET) return c.SESSION_SECRET;
  if (c.NODE_ENV === "production") throw new Error("SESSION_SECRET fehlt");
  return "dev-only-session-secret-not-for-production-use!!";
}

/** Shopify ist nutzbar, wenn Shop-Domain und entweder festes Token oder Client ID + Secret vorhanden sind */
export function shopifyConfigured(): boolean {
  const c = config();
  return !!c.SHOPIFY_SHOP_DOMAIN && (!!c.SHOPIFY_ACCESS_TOKEN?.trim() || (!!c.SHOPIFY_CLIENT_ID && !!c.SHOPIFY_CLIENT_SECRET));
}
