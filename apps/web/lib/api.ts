export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
  if (!res.ok) throw new ApiError([data.error, ...(data.issues ?? [])].filter(Boolean).join(" – ") || `Fehler ${res.status}`, res.status);
  return data as T;
}

export const CAMPAIGN_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: "Wartend", tone: "gray" },
  SCHEDULED: { label: "Geplant", tone: "blue" },
  ACTIVE: { label: "Aktiv", tone: "blue" },
  PAUSED: { label: "Pausiert", tone: "amber" },
  COMPLETED: { label: "Abgeschlossen", tone: "green" },
  CANCELLED: { label: "Abgebrochen", tone: "gray" },
  REVIEW_RECEIVED: { label: "Bewertung erhalten", tone: "green" },
  CONSENT_MISSING: { label: "Einwilligung fehlt", tone: "red" },
  REVIEW_STATUS_UNKNOWN: { label: "Bewertungsstatus unbekannt", tone: "gray" },
};

export const DELIVERY_STATUS: Record<string, string> = {
  ORDER_RECEIVED: "Bestellung eingegangen",
  PROCESSING: "In Bearbeitung",
  SHIPPED: "Versendet",
  IN_TRANSIT: "Unterwegs",
  DELIVERED: "Zugestellt",
  DELIVERY_UNKNOWN: "Zustellung unbekannt",
  DELAYED: "Zustellung verzögert",
  FAILED: "Zustellung fehlgeschlagen",
  CANCELLED: "Storniert",
  RETURNED: "Retoure",
};

export const INVITATION_STATUS: Record<string, string> = {
  SCHEDULED: "geplant",
  SENDING: "wird gesendet",
  SENT: "gesendet",
  FAILED: "Fehler",
  SKIPPED: "übersprungen",
  CANCELLED: "abgebrochen",
};

export const CHANNELS: Record<string, string> = {
  IDEALO: "idealo",
  GOOGLE_SHOPPING: "Google Shopping",
  GOOGLE_ADS: "Google Ads",
  GOOGLE_ORGANIC: "Google organisch",
  GEIZHALS: "Geizhals",
  BILLIGER: "billiger.de",
  DIRECT: "Direktzugriff",
  EMAIL: "E-Mail-Marketing",
  SOCIAL: "Social Media",
  OTHER: "Sonstige",
  UNKNOWN: "Unbekannt",
};

export const RULES: Record<string, string> = { TRACKED: "A – nach Zustellung", UNTRACKED_FALLBACK: "B – ohne Zustellbestätigung" };
export const REVIEW_STATUS: Record<string, string> = { UNKNOWN: "unbekannt", NOT_REVIEWED: "nicht bewertet", REVIEWED: "bewertet" };

export type Tone = "gray" | "blue" | "green" | "amber" | "red";

export function fmtDate(v: string | null | undefined, withTime = false): string {
  if (!v) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(new Date(v));
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? "–" : `${(v * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return v == null ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
