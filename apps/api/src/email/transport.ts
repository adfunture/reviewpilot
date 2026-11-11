import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { logger, maskEmail } from "../lib/logger.js";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
}

/** Fehler mit Einstufung: dauerhaft (harter Bounce) oder vorübergehend */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly recipientRejected: boolean,
  ) {
    super(message);
  }
}

export interface EmailTransport {
  readonly kind: "smtp" | "log" | "memory";
  send(mail: OutgoingEmail): Promise<SendResult>;
}

class SmtpTransport implements EmailTransport {
  readonly kind = "smtp" as const;
  private readonly t: Transporter;
  constructor() {
    const c = config();
    if (!c.SMTP_HOST || !c.EMAIL_FROM) throw new Error("SMTP nicht konfiguriert (SMTP_HOST, EMAIL_FROM)");
    this.t = nodemailer.createTransport({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_SECURE || c.SMTP_PORT === 465,
      auth: c.SMTP_USER ? { user: c.SMTP_USER, pass: c.SMTP_PASSWORD } : undefined,
      pool: true,
      maxConnections: 2,
    });
  }
  async send(mail: OutgoingEmail): Promise<SendResult> {
    const c = config();
    try {
      const info = await this.t.sendMail({ from: c.EMAIL_FROM, replyTo: c.EMAIL_REPLY_TO, ...mail });
      if (info.rejected?.length) throw new EmailSendError(`Empfänger abgelehnt: ${info.response}`, true, true);
      return { messageId: info.messageId };
    } catch (err) {
      if (err instanceof EmailSendError) throw err;
      const e = err as { responseCode?: number; message: string };
      const code = e.responseCode ?? 0;
      // 5xx = dauerhaft; 550/551/553 = Empfänger existiert nicht → harter Bounce
      throw new EmailSendError(e.message, code >= 500, [550, 551, 553].includes(code));
    }
  }
}

/** Versendet nichts – protokolliert nur (Standard, bis SMTP bewusst konfiguriert ist) */
class LogTransport implements EmailTransport {
  readonly kind = "log" as const;
  async send(mail: OutgoingEmail): Promise<SendResult> {
    logger.info({ to: maskEmail(mail.to), subject: mail.subject }, "E-Mail (Log-Transport, NICHT versendet)");
    return { messageId: `log-${Date.now()}` };
  }
}

/** Für Tests */
export class MemoryTransport implements EmailTransport {
  readonly kind = "memory" as const;
  sent: OutgoingEmail[] = [];
  failNext: EmailSendError | null = null;
  async send(mail: OutgoingEmail): Promise<SendResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push(mail);
    return { messageId: `mem-${this.sent.length}` };
  }
}

let current: EmailTransport | undefined;

export function emailTransport(): EmailTransport {
  if (!current) current = config().EMAIL_TRANSPORT === "smtp" ? new SmtpTransport() : new LogTransport();
  return current;
}

export function setEmailTransport(t: EmailTransport | undefined): void {
  current = t;
}
