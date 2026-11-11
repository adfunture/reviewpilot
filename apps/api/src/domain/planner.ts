import { createHash } from "node:crypto";
import type { CampaignStatus, DeliveryStatus, IntegrationType, LegalBasis, PlatformKey, SalesChannel, ShippingRule } from "@prisma/client";
import { calendarDaysAfter, intoSendWindow } from "./time.js";

export interface RuleSettings {
  firstRequestDaysAfterDelivery: number;
  fallbackDaysAfterOrder: number;
  reminderIntervalDays: number;
  maxAttempts: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  timezone: string;
  legalBasis: LegalBasis;
  includeRefundedOrders?: boolean;
}

export interface PlatformOption {
  id: string;
  key: PlatformKey;
  active: boolean;
  integrationType: IntegrationType;
  reviewUrl: string | null;
  priority: number;
  targetShare: number;
  extraDelayDays: number;
  onlyForChannels: SalesChannel[];
}

export interface PlanInput {
  orderId: string;
  orderCreatedAt: Date;
  isTest: boolean;
  email: string | null;
  cancelledAt: Date | null;
  totalPrice: number;
  totalRefunded: number;
  deliveryStatus: DeliveryStatus;
  deliveredAt: Date | null;
  fullyShipped: boolean;
  shippedAt: Date | null;
  hasTracking: boolean;
  isFreight: boolean;
  channel: SalesChannel;
  reviewBlocked: boolean;
  suppressed: boolean; // Abmeldung, Widerspruch, harter Bounce
  consent: "GRANTED" | "REVOKED" | "OBJECTED" | "NONE";
}

export type PlanResult =
  | { kind: "terminal"; status: Extract<CampaignStatus, "CANCELLED" | "CONSENT_MISSING">; reason: string }
  | { kind: "wait"; status: Extract<CampaignStatus, "PENDING" | "PAUSED">; reason: string }
  | {
      kind: "schedule";
      rule: ShippingRule;
      anchorAt: Date;
      platform: PlatformOption;
      dates: Date[]; // geplante Versandzeitpunkte für Stufe 1..n (vor Zeitfenster-/Verspätungsprüfung)
    };

/** Stufen-Zeitpunkte ab Anker (Variante A: Zustellung + X Tage; Variante B: Bestellung + 14/17/20 Tage) */
export function stepDates(rule: ShippingRule, anchorAt: Date, s: RuleSettings, extraDelayDays = 0): Date[] {
  const firstOffset = (rule === "TRACKED" ? s.firstRequestDaysAfterDelivery : s.fallbackDaysAfterOrder) + extraDelayDays;
  const dates: Date[] = [];
  for (let step = 0; step < s.maxAttempts; step++) {
    dates.push(calendarDaysAfter(anchorAt, firstOffset + step * s.reminderIntervalDays, s.sendWindowStartHour, s.timezone));
  }
  return dates;
}

/** Deterministische, kundenunabhängige gewichtete Plattformwahl (Hash der Bestell-ID). Kein Review-Gating. */
export function selectPlatform(orderId: string, channel: SalesChannel, platforms: PlatformOption[]): PlatformOption | null {
  const eligible = platforms
    .filter((p) => p.active && p.integrationType === "LINK" && !!p.reviewUrl)
    .filter((p) => p.onlyForChannels.length === 0 || p.onlyForChannels.includes(channel))
    .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  if (eligible.length === 0) return null;
  const total = eligible.reduce((sum, p) => sum + Math.max(0, p.targetShare), 0);
  if (total <= 0) return eligible[0]!;
  const bucket = createHash("sha256").update(orderId).digest().readUInt32BE(0) % total;
  let acc = 0;
  for (const p of eligible) {
    acc += Math.max(0, p.targetShare);
    if (bucket < acc) return p;
  }
  return eligible[eligible.length - 1]!;
}

/**
 * Entscheidet, ob/wie eine Kampagne geplant wird. Reine Funktion – alle Regeln aus dem Master-Prompt, Kapitel 6–9.
 */
export function planCampaign(input: PlanInput, s: RuleSettings, platforms: PlatformOption[]): PlanResult {
  // Endgültige Ausschlüsse
  if (input.isTest) return { kind: "terminal", status: "CANCELLED", reason: "Testbestellung" };
  if (input.cancelledAt || input.deliveryStatus === "CANCELLED") return { kind: "terminal", status: "CANCELLED", reason: "Bestellung storniert" };
  // Erstattung/Retoure: Kunde hat die Ware erhalten → auf Wunsch trotzdem anfragen (kein selektives Auslassen
  // unzufriedener Kunden). Ausschalten in den Einstellungen möglich.
  if (!s.includeRefundedOrders) {
    if (input.totalPrice > 0 && input.totalRefunded >= input.totalPrice) return { kind: "terminal", status: "CANCELLED", reason: "Vollständig erstattet" };
    if (input.deliveryStatus === "RETURNED") return { kind: "terminal", status: "CANCELLED", reason: "Retoure" };
  }
  if (input.reviewBlocked) return { kind: "terminal", status: "CANCELLED", reason: "Bewertungsanfragen für diese Bestellung gesperrt" };
  if (!input.email) return { kind: "terminal", status: "CANCELLED", reason: "Keine E-Mail-Adresse" };
  if (input.suppressed) return { kind: "terminal", status: "CANCELLED", reason: "Abgemeldet / Widerspruch / unzustellbar" };

  // Rechtsgrundlage
  if (s.legalBasis === "NONE") return { kind: "terminal", status: "CONSENT_MISSING", reason: "Keine Rechtsgrundlage konfiguriert" };
  if (input.consent === "REVOKED" || input.consent === "OBJECTED") return { kind: "terminal", status: "CONSENT_MISSING", reason: "Einwilligung widerrufen / Widerspruch" };
  if (s.legalBasis === "CONSENT" && input.consent !== "GRANTED") return { kind: "terminal", status: "CONSENT_MISSING", reason: "Keine Einwilligung des Kunden" };

  // Zeitweilige Hindernisse (pausieren, nicht dauerhaft unterdrücken)
  if (input.deliveryStatus === "FAILED") return { kind: "wait", status: "PAUSED", reason: "Zustellung fehlgeschlagen" };
  if (input.deliveryStatus === "DELAYED") return { kind: "wait", status: "PAUSED", reason: "Lieferung verzögert" };
  if (!input.fullyShipped) return { kind: "wait", status: "PENDING", reason: "Noch nicht (vollständig) versendet" };

  const platform = selectPlatform(input.orderId, input.channel, platforms);
  if (!platform) return { kind: "wait", status: "PENDING", reason: "Keine aktive Bewertungsplattform mit Link für diese Bestellung" };

  // Variante A: bestätigte Zustellung
  if (input.deliveryStatus === "DELIVERED" && input.deliveredAt) {
    return { kind: "schedule", rule: "TRACKED", anchorAt: input.deliveredAt, platform, dates: stepDates("TRACKED", input.deliveredAt, s, platform.extraDelayDays) };
  }
  // Variante B: keine bestätigte Zustellung (Spedition, keine Trackingnummer, keine Carrier-Events oder
  // Tracking bleibt auf "unterwegs" – bei Deutsche Post in Shopify häufig). Ein Versand ist KEINE Zustellung,
  // daher frühestens 14 Tage nach Bestellung. Trifft vor Stufe 1 eine Zustellbestätigung ein, wird auf A umgeplant.
  if (input.deliveryStatus === "DELIVERY_UNKNOWN" || input.deliveryStatus === "SHIPPED" || input.deliveryStatus === "IN_TRANSIT" || input.deliveryStatus === "RETURNED") {
    const anchorAt = untrackedAnchor(input.orderCreatedAt, input.shippedAt, s);
    return { kind: "schedule", rule: "UNTRACKED_FALLBACK", anchorAt, platform, dates: stepDates("UNTRACKED_FALLBACK", anchorAt, s, platform.extraDelayDays) };
  }
  return { kind: "wait", status: "PENDING", reason: `Status ${input.deliveryStatus}` };
}

/** Mindestabstand zwischen Versand und erster Anfrage ohne Zustellbestätigung (Tage) */
export const MIN_DAYS_AFTER_UNTRACKED_SHIPMENT = 7;

/**
 * Anker für Variante B: Bestelldatum. Wurde verspätet versendet (z. B. erst nach 14 Tagen), wird der Anker so
 * verschoben, dass die erste Anfrage frühestens 7 Tage nach Versand erfolgt – statt sie als „verpasst“ zu verwerfen
 * oder rückwirkend sofort zu senden.
 */
export function untrackedAnchor(orderCreatedAt: Date, shippedAt: Date | null, s: RuleSettings): Date {
  if (!shippedAt) return orderCreatedAt;
  const earliestAnchor = new Date(shippedAt.getTime() - (s.fallbackDaysAfterOrder - MIN_DAYS_AFTER_UNTRACKED_SHIPMENT) * 86400_000);
  return earliestAnchor > orderCreatedAt ? earliestAnchor : orderCreatedAt;
}

/** Maximale Verspätung, ab der eine Stufe NICHT mehr automatisch nachgeholt wird (keine rückwirkende Massenversendung) */
export const MAX_LATE_HOURS = 48;

/**
 * Bewertet einen geplanten Zeitpunkt gegen "jetzt":
 * - in der Zukunft → ins Versandfenster legen
 * - bis 48 h verspätet (z. B. Zustellung spät gemeldet) → nächstes Versandfenster
 * - älter → "missed" (nicht nachholen)
 */
export function resolveSendTime(planned: Date, now: Date, s: RuleSettings): { at: Date } | { missed: true } {
  if (planned.getTime() >= now.getTime()) return { at: intoSendWindow(planned, s.sendWindowStartHour, s.sendWindowEndHour, s.timezone) };
  if (now.getTime() - planned.getTime() <= MAX_LATE_HOURS * 3600_000) {
    return { at: intoSendWindow(now, s.sendWindowStartHour, s.sendWindowEndHour, s.timezone) };
  }
  return { missed: true };
}
