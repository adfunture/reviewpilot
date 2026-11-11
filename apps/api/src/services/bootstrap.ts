import type { IntegrationType, PlatformKey, SalesChannel } from "@prisma/client";
import { DEFAULT_MAPPING_RULES } from "../domain/attribution.js";
import { DEFAULT_TEMPLATES, GOOGLE_BUSINESS_TEMPLATES } from "../email/render.js";
import { db } from "../lib/db.js";

interface PlatformDefault {
  key: PlatformKey;
  name: string;
  integrationType: IntegrationType;
  apiAvailable: boolean;
  statusQueryAvailable: boolean;
  remindersAllowed: boolean;
  priority: number;
  targetShare: number;
  onlyForChannels: SalesChannel[];
  notes: string;
}

/**
 * Plattform-Standardwerte – alle INAKTIV und ohne Link. Links werden nicht erfunden, sondern vom Händler
 * aus dem jeweiligen offiziellen Händlerbereich kopiert.
 */
export const PLATFORM_DEFAULTS: PlatformDefault[] = [
  {
    key: "GOOGLE_BUSINESS",
    name: "Google Unternehmensprofil",
    integrationType: "LINK",
    apiAvailable: false,
    statusQueryAvailable: false,
    // Entscheidung Adfunture (11.11.2026): genau EINE Anfrage pro Bestellung – Google meldet keinen Bewertungsstatus
    remindersAllowed: false,
    priority: 10,
    targetShare: 100, // Entscheidung Adfunture (11.11.2026): Händlerbewertungen zuerst nur über Google

    onlyForChannels: [],
    notes: "Offiziellen Link „Rezension schreiben“ aus dem Google-Unternehmensprofil einfügen. Bewertungsstatus ist nicht bestellbezogen abrufbar.",
  },
  {
    key: "IDEALO",
    name: "idealo",
    integrationType: "LINK",
    apiAvailable: false,
    statusQueryAvailable: false,
    remindersAllowed: false,
    priority: 20,
    targetShare: 0,
    onlyForChannels: ["IDEALO"],
    notes: "Keine öffentliche Einladungs-API gefunden. Offiziellen Bewertungslink und Regeln bei idealo business erfragen. Standard: nur für über idealo vermittelte Bestellungen.",
  },
  {
    key: "TRUSTED_SHOPS",
    name: "Trusted Shops",
    integrationType: "LINK",
    apiAvailable: false,
    statusQueryAvailable: false,
    remindersAllowed: false,
    priority: 30,
    targetShare: 0,
    onlyForChannels: [],
    notes: "Optional, kostenpflichtig. Nur mit eigenem Trusted-Shops-Vertrag nutzen.",
  },
  {
    key: "TRUSTPILOT",
    name: "Trustpilot",
    integrationType: "LINK",
    apiAvailable: false,
    statusQueryAvailable: false,
    remindersAllowed: false,
    priority: 40,
    targetShare: 0,
    onlyForChannels: [],
    notes: "Optional. Trustpilot-Richtlinien: keine selektive Einladung.",
  },
  {
    key: "JUDGEME",
    name: "Judge.me (Produktbewertungen)",
    integrationType: "EXTERNAL_PROGRAM",
    apiAvailable: true,
    statusQueryAvailable: true,
    remindersAllowed: false,
    priority: 90,
    targetShare: 0,
    onlyForChannels: [],
    notes: "Judge.me versendet eigene Produktbewertungsanfragen. ReviewPilot liest nur vorhandene Bewertungen (API-Token nötig).",
  },
  {
    key: "GOOGLE_CUSTOMER_REVIEWS",
    name: "Google Kundenrezensionen (Merchant Center)",
    integrationType: "EXTERNAL_PROGRAM",
    apiAvailable: false,
    statusQueryAvailable: false,
    remindersAllowed: false,
    priority: 95,
    targetShare: 0,
    onlyForChannels: [],
    notes: "Google versendet die Umfrage selbst nach Opt-in auf der Bestellbestätigungsseite. Kein Versand durch ReviewPilot. Siehe docs/GOOGLE_KUNDENREZENSIONEN.md.",
  },
];

/** Legt Shop + Standardkonfiguration idempotent an (vorhandene Einstellungen bleiben unverändert) */
export async function ensureShop(shopifyDomain: string, name: string): Promise<string> {
  const prisma = db();
  const shop = await prisma.shop.upsert({ where: { shopifyDomain }, create: { shopifyDomain, name }, update: {} });
  // Entscheidung Adfunture (11.11.2026): Anfrage an jede Bestellung → § 7 Abs. 3 UWG voreingestellt.
  // Versand bleibt trotzdem gesperrt, bis der Inhaber den Widerspruchshinweis bestätigt und freigibt.
  await prisma.reviewRule.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, legalBasis: "UWG_7_3" }, update: {} });
  for (const p of PLATFORM_DEFAULTS) {
    await prisma.reviewPlatform.upsert({ where: { shopId_key: { shopId: shop.id, key: p.key } }, create: { shopId: shop.id, ...p, active: false }, update: {} });
  }
  for (const t of DEFAULT_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { shopId_scope_step: { shopId: shop.id, scope: "default", step: t.step } },
      create: { shopId: shop.id, scope: "default", step: t.step, subject: t.subject, bodyText: t.body },
      update: {},
    });
  }
  const google = await prisma.reviewPlatform.findUniqueOrThrow({ where: { shopId_key: { shopId: shop.id, key: "GOOGLE_BUSINESS" } } });
  for (const t of GOOGLE_BUSINESS_TEMPLATES) {
    await prisma.emailTemplate.upsert({
      where: { shopId_scope_step: { shopId: shop.id, scope: "GOOGLE_BUSINESS", step: t.step } },
      create: { shopId: shop.id, scope: "GOOGLE_BUSINESS", platformId: google.id, step: t.step, subject: t.subject, bodyText: t.body },
      update: {},
    });
  }
  const existingRules = await prisma.channelMappingRule.count({ where: { shopId: shop.id } });
  if (existingRules === 0) {
    await prisma.channelMappingRule.createMany({ data: DEFAULT_MAPPING_RULES.map((r) => ({ shopId: shop.id, field: r.field, pattern: r.pattern, channel: r.channel, priority: r.priority })) });
  }
  return shop.id;
}
