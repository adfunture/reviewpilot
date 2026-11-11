import type { PlatformKey } from "@prisma/client";

/**
 * Prüft, ob ein hinterlegter Bewertungslink zur Plattform passt. Es werden keine Links erzeugt,
 * nur offensichtliche Fehler abgefangen (z. B. Maps-Teilen-Link statt Bewertungsformular).
 */
export function reviewUrlProblem(key: PlatformKey, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Ungültige URL";
  }
  if (url.protocol !== "https:") return "Der Link muss mit https:// beginnen";

  if (key === "GOOGLE_BUSINESS") {
    // 1) Link aus dem Unternehmensprofil („Rezensionen erhalten“ → Link kopieren): https://g.page/r/<code>/review
    if (url.hostname === "g.page" && /^\/r\/[A-Za-z0-9_-]+\/review\/?$/.test(url.pathname)) return null;
    // 2) Formular über die Place-ID: https://search.google.com/local/writereview?placeid=<ID>
    if (url.hostname === "search.google.com" && url.pathname === "/local/writereview" && /^[A-Za-z0-9_-]{10,}$/.test(url.searchParams.get("placeid") ?? "")) return null;
    return "Kein Google-Bewertungslink. Bitte im Google-Unternehmensprofil „Rezensionen erhalten“ öffnen und den Link kopieren (Form: https://g.page/r/…/review).";
  }
  return null;
}

/** Inhalte, die gegen Google-/UWG-Regeln für Bewertungsanfragen verstoßen würden (Anreize, Einflussnahme auf die Bewertung) */
const POLICY_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /gutschein|rabatt|discount|coupon|prozent auf|% auf/i, reason: "Anreiz (Gutschein/Rabatt) für Bewertungen ist unzulässig" },
  { re: /gewinnspiel|verlosung|gewinne?n? /i, reason: "Gewinnspiel als Anreiz für Bewertungen ist unzulässig" },
  { re: /\b5[ -]?sterne|fünf sterne|positive bewertung|gute bewertung/i, reason: "Keine Aufforderung zu einer bestimmten (positiven) Bewertung" },
  { re: /cashback|geld zurück|belohnung/i, reason: "Belohnung für Bewertungen ist unzulässig" },
];

export function templatePolicyProblems(text: string): string[] {
  return POLICY_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.reason);
}
