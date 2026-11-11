import type { AttributionConfidence, SalesChannel } from "@prisma/client";

export type MappingField = "utm_source" | "utm_medium" | "referrer_host" | "landing_page" | "source_name";

export interface MappingRule {
  field: MappingField | string;
  pattern: string;
  channel: SalesChannel;
  priority: number;
  active?: boolean;
}

export interface AttributionInput {
  sourceName?: string | null;
  referrerUrl?: string | null;
  landingPage?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
}

export interface AttributionResult {
  channel: SalesChannel;
  method: string;
  confidence: AttributionConfidence;
}

/** Standard-Mapping-Tabelle (beim Seed in channel_mapping_rules angelegt und im Dashboard änderbar) */
export const DEFAULT_MAPPING_RULES: MappingRule[] = [
  { field: "utm_source", pattern: "idealo", channel: "IDEALO", priority: 10 },
  { field: "utm_source", pattern: "geizhals", channel: "GEIZHALS", priority: 10 },
  { field: "utm_source", pattern: "billiger", channel: "BILLIGER", priority: 10 },
  { field: "utm_medium", pattern: "cpc", channel: "GOOGLE_ADS", priority: 30 }, // nur zusammen mit utm_source=google, s. u.
  { field: "utm_source", pattern: "google", channel: "GOOGLE_SHOPPING", priority: 40 },
  { field: "utm_source", pattern: "newsletter", channel: "EMAIL", priority: 20 },
  { field: "utm_medium", pattern: "email", channel: "EMAIL", priority: 20 },
  { field: "utm_source", pattern: "facebook", channel: "SOCIAL", priority: 20 },
  { field: "utm_source", pattern: "instagram", channel: "SOCIAL", priority: 20 },
  { field: "utm_source", pattern: "tiktok", channel: "SOCIAL", priority: 20 },
  { field: "utm_source", pattern: "pinterest", channel: "SOCIAL", priority: 20 },
  { field: "landing_page", pattern: "gclid=", channel: "GOOGLE_ADS", priority: 50 },
  { field: "referrer_host", pattern: "idealo.", channel: "IDEALO", priority: 60 },
  { field: "referrer_host", pattern: "geizhals.", channel: "GEIZHALS", priority: 60 },
  { field: "referrer_host", pattern: "billiger.de", channel: "BILLIGER", priority: 60 },
  { field: "referrer_host", pattern: "google.", channel: "GOOGLE_ORGANIC", priority: 70 },
  { field: "referrer_host", pattern: "facebook.", channel: "SOCIAL", priority: 70 },
  { field: "referrer_host", pattern: "instagram.", channel: "SOCIAL", priority: 70 },
];

function host(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function utmFromLanding(landing?: string | null): { source?: string; medium?: string } {
  if (!landing) return {};
  try {
    const u = new URL(landing, "https://shop.invalid");
    return { source: u.searchParams.get("utm_source") ?? undefined, medium: u.searchParams.get("utm_medium") ?? undefined };
  } catch {
    return {};
  }
}

/**
 * Erkennt den Herkunftskanal. Reihenfolge: Regeln nach Priorität. Keine Annahmen:
 * - Ohne verwertbare Daten → UNKNOWN / NONE.
 * - Shopify-sourceName "web" ohne Referrer und ohne UTM → DIRECT nur mit LOW-Zuverlässigkeit.
 */
export function detectChannel(input: AttributionInput, rules: MappingRule[] = DEFAULT_MAPPING_RULES): AttributionResult {
  const landingUtm = utmFromLanding(input.landingPage);
  const values: Record<MappingField, string | null> = {
    utm_source: (input.utmSource ?? landingUtm.source ?? null)?.toLowerCase() ?? null,
    utm_medium: (input.utmMedium ?? landingUtm.medium ?? null)?.toLowerCase() ?? null,
    referrer_host: host(input.referrerUrl),
    landing_page: input.landingPage?.toLowerCase() ?? null,
    source_name: input.sourceName?.toLowerCase() ?? null,
  };

  const sorted = rules.filter((r) => r.active !== false).sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    const value = values[rule.field as MappingField];
    if (!value || !value.includes(rule.pattern.toLowerCase())) continue;
    // Google Ads nur, wenn die Quelle ebenfalls Google ist (cpc allein ist kein Google-Beleg)
    if (rule.channel === "GOOGLE_ADS" && rule.field === "utm_medium" && !(values.utm_source ?? "").includes("google")) continue;
    const confidence: AttributionConfidence =
      rule.field === "utm_source" || rule.field === "utm_medium" ? "HIGH" : rule.field === "landing_page" ? "MEDIUM" : rule.field === "source_name" ? "MEDIUM" : "MEDIUM";
    return { channel: rule.channel, method: rule.field, confidence };
  }

  if (values.utm_source) return { channel: "OTHER", method: "utm_source", confidence: "MEDIUM" };
  if (values.referrer_host) return { channel: "OTHER", method: "referrer_host", confidence: "LOW" };
  if (values.source_name === "web" && input.landingPage) {
    // Shopify kennt einen Besuch mit Landingpage, aber weder Referrer noch UTM → wahrscheinlich Direktzugriff
    return { channel: "DIRECT", method: "no_referrer", confidence: "LOW" };
  }
  return { channel: "UNKNOWN", method: "none", confidence: "NONE" };
}
