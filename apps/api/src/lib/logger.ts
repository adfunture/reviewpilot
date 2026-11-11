import pino from "pino";

// Strukturiertes JSON-Logging (Railway parst JSON-Zeilen). E-Mail-Adressen werden maskiert.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.RAILWAY_SERVICE_NAME ?? "reviewpilot" },
  redact: { paths: ["email", "*.email", "to", "*.to", "password", "*.password", "token", "*.token"], censor: "[redacted]" },
});

export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const [user, domain] = email.split("@");
  return `${(user ?? "").slice(0, 2)}***@${domain ?? ""}`;
}
