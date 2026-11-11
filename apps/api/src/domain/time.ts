// Zeitzonen-Hilfen ohne externe Abhängigkeit (Intl). Alle Kalendertage werden in der Shop-Zeitzone gerechnet.

export interface Ymd {
  y: number;
  m: number; // 1–12
  d: number;
}

export function localYmd(date: Date, timeZone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function localHour(date: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date);
  return Number(h);
}

function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Lokale Uhrzeit (Kalendertag + Stunde) in der Zeitzone → absoluter Zeitpunkt */
export function zonedTime(ymd: Ymd, hour: number, timeZone: string): Date {
  const guess = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour, 0, 0);
  let result = new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60000);
  // zweite Iteration für Sommer-/Winterzeitwechsel
  result = new Date(guess - offsetMinutes(result, timeZone) * 60000);
  return result;
}

export function addDays(ymd: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** Kalendertag des Ankers + N Tage, zur Startstunde des Versandfensters */
export function calendarDaysAfter(anchor: Date, days: number, hour: number, timeZone: string): Date {
  return zonedTime(addDays(localYmd(anchor, timeZone), days), hour, timeZone);
}

/** Verschiebt einen Zeitpunkt in das nächste zulässige Versandfenster */
export function intoSendWindow(at: Date, startHour: number, endHour: number, timeZone: string): Date {
  const h = localHour(at, timeZone);
  const ymd = localYmd(at, timeZone);
  if (h < startHour) return zonedTime(ymd, startHour, timeZone);
  if (h >= endHour) return zonedTime(addDays(ymd, 1), startHour, timeZone);
  return at;
}

export function formatDateDe(date: Date | null | undefined, timeZone = "Europe/Berlin"): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("de-DE", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}
