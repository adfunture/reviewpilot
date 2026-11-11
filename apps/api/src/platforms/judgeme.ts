import { decrypt, encrypt } from "../lib/crypto.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Judge.me – nur dokumentierte Endpunkte (judge.me/help, Artikel „Judge.me API“):
 *   GET https://api.judge.me/api/v1/reviews?shop_domain=…&api_token=…&reviewer_email=…&per_page=…
 * Nicht verfügbar laut Doku: Abruf versendeter Einladungen, Webhooks.
 * Ob der Free-Tarif API-Zugriff erlaubt, ist nicht dokumentiert → wird per echtem Aufruf getestet.
 */
const API = "https://api.judge.me/api/v1";

export interface JudgemeConfig {
  shopDomain: string;
  apiToken: string;
}

export interface JudgemeReview {
  id: number;
  rating: number;
  created_at: string;
  reviewer?: { email?: string | null } | null;
}

export const JUDGEME_CAPABILITIES = {
  readReviews: true, // nach erfolgreichem Verbindungstest
  readInvitations: false, // keine dokumentierte API
  webhooks: false, // keine dokumentierten Webhooks
};

export async function loadJudgemeConfig(shopId: string): Promise<JudgemeConfig | null> {
  const row = await db().shopIntegration.findUnique({ where: { shopId_provider: { shopId, provider: "judgeme" } } });
  if (!row?.encryptedConfig || row.status !== "OK") return null;
  return JSON.parse(decrypt(row.encryptedConfig)) as JudgemeConfig;
}

export async function saveJudgemeConfig(shopId: string, cfg: JudgemeConfig): Promise<void> {
  const encryptedConfig = encrypt(JSON.stringify(cfg));
  await db().shopIntegration.upsert({
    where: { shopId_provider: { shopId, provider: "judgeme" } },
    create: { shopId, provider: "judgeme", encryptedConfig, status: "NOT_CONFIGURED" },
    update: { encryptedConfig, status: "NOT_CONFIGURED", statusDetail: null },
  });
}

export async function fetchReviews(cfg: JudgemeConfig, params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<JudgemeReview[]> {
  const qs = new URLSearchParams({ shop_domain: cfg.shopDomain, api_token: cfg.apiToken, per_page: "100", ...params });
  const res = await fetchImpl(`${API}/reviews?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Judge.me HTTP ${res.status}`);
  const json = (await res.json()) as { reviews?: JudgemeReview[] };
  return json.reviews ?? [];
}

/** Echter Verbindungstest – Ergebnis wird gespeichert und im Dashboard angezeigt (keine vorgetäuschte Synchronisierung) */
export async function testJudgeme(shopId: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const row = await db().shopIntegration.findUnique({ where: { shopId_provider: { shopId, provider: "judgeme" } } });
  if (!row?.encryptedConfig) return { ok: false, detail: "Kein API-Token hinterlegt" };
  const cfg = JSON.parse(decrypt(row.encryptedConfig)) as JudgemeConfig;
  let result: { ok: boolean; detail: string };
  try {
    const reviews = await fetchReviews(cfg, { per_page: "1" }, fetchImpl);
    result = { ok: true, detail: `Bewertungen abrufbar (Stichprobe: ${reviews.length}). Einladungen: nicht per API abrufbar.` };
  } catch (err) {
    result = { ok: false, detail: `Abruf fehlgeschlagen: ${(err as Error).message}` };
  }
  await db().shopIntegration.update({
    where: { id: row.id },
    data: { status: result.ok ? "OK" : "ERROR", statusDetail: result.detail, lastCheckedAt: new Date() },
  });
  return result;
}

/** Hat der Kunde nach Bestelldatum eine Judge.me-Bewertung abgegeben? null = nicht prüfbar */
export async function hasJudgemeReviewSince(shopId: string, email: string, since: Date, fetchImpl: typeof fetch = fetch): Promise<JudgemeReview | null | undefined> {
  const cfg = await loadJudgemeConfig(shopId);
  if (!cfg) return undefined; // nicht prüfbar
  try {
    const reviews = await fetchReviews(cfg, { reviewer_email: email }, fetchImpl);
    return reviews.find((r) => new Date(r.created_at) >= since && (!r.reviewer?.email || r.reviewer.email.toLowerCase() === email.toLowerCase())) ?? null;
  } catch (err) {
    logger.warn({ err }, "Judge.me-Abfrage fehlgeschlagen");
    return undefined;
  }
}
