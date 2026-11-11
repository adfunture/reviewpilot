import type { ReviewRule } from "@prisma/client";
import type { RuleSettings } from "./planner.js";

export function toRuleSettings(r: ReviewRule): RuleSettings {
  return {
    firstRequestDaysAfterDelivery: r.firstRequestDaysAfterDelivery,
    fallbackDaysAfterOrder: r.fallbackDaysAfterOrder,
    reminderIntervalDays: r.reminderIntervalDays,
    maxAttempts: r.maxAttempts,
    sendWindowStartHour: r.sendWindowStartHour,
    sendWindowEndHour: r.sendWindowEndHour,
    timezone: r.timezone,
    legalBasis: r.legalBasis,
    includeRefundedOrders: r.includeRefundedOrders,
  };
}

export const MANUAL_PAUSE_REASON = "Manuell pausiert";
export const MANUAL_CANCEL_REASON = "Manuell abgebrochen";
