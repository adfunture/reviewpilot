import type { ReviewStatus } from "@prisma/client";

export interface ReminderContext {
  step: number; // 2 oder 3
  reviewStatus: ReviewStatus;
  platformRemindersAllowed: boolean;
  platformStatusQueryAvailable: boolean;
  remindersOnUnknownStatus: boolean;
}

/**
 * Darf eine Erinnerung (Stufe ≥ 2) versendet werden?
 * - Nur, wenn die Plattform Erinnerungen erlaubt.
 * - Nur, wenn NACHWEISLICH keine Bewertung vorliegt (Status per API abgefragt).
 * - Bei unbekanntem Status nur, wenn ausdrücklich freigeschaltet (Standard: aus).
 */
export function reminderDecision(ctx: ReminderContext): { allowed: true } | { allowed: false; reason: string; unknown: boolean } {
  if (ctx.step < 2) return { allowed: true };
  if (ctx.reviewStatus === "REVIEWED") return { allowed: false, reason: "Bewertung liegt vor", unknown: false };
  if (!ctx.platformRemindersAllowed) return { allowed: false, reason: "Plattform erlaubt keine Erinnerungen", unknown: ctx.reviewStatus === "UNKNOWN" };
  if (ctx.reviewStatus === "NOT_REVIEWED" && ctx.platformStatusQueryAvailable) return { allowed: true };
  if (ctx.remindersOnUnknownStatus) return { allowed: true };
  return { allowed: false, reason: "Bewertungsstatus unbekannt – Erinnerungen deaktiviert", unknown: true };
}
