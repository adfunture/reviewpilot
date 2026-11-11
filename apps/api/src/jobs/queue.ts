import { randomUUID } from "node:crypto";
import { Prisma, type Job } from "@prisma/client";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Persistente Job-Queue in PostgreSQL.
 * - Reservierung per FOR UPDATE SKIP LOCKED (mehrere Worker möglich)
 * - Retry mit exponentiellem Backoff, danach DEAD (Dead-Letter, im Dashboard sichtbar)
 * - dedupeKey verhindert doppelte Jobs (z. B. pro Webhook oder Zeitfenster)
 * - Übersteht Neustarts: hängende RUNNING-Jobs werden wieder freigegeben
 */
export async function enqueue(type: string, payload: object = {}, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}): Promise<boolean> {
  try {
    await db().job.create({ data: { type, payload: payload as Prisma.InputJsonValue, runAt: opts.runAt ?? new Date(), dedupeKey: opts.dedupeKey, maxAttempts: opts.maxAttempts ?? 5 } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false; // Duplikat
    throw err;
  }
}

export async function claimNext(workerId: string): Promise<Job | null> {
  const rows = await db().$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'RUNNING', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs WHERE status IN ('PENDING', 'FAILED') AND run_at <= now()
      ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  if (!rows[0]) return null;
  return db().job.findUnique({ where: { id: rows[0].id } });
}

export function backoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 30_000 * 2 ** (attempts - 1));
}

export async function complete(id: string): Promise<void> {
  await db().job.update({ where: { id }, data: { status: "DONE", finishedAt: new Date(), lockedAt: null, lockedBy: null } });
}

export async function fail(job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const dead = job.attempts >= job.maxAttempts;
  await db().job.update({
    where: { id: job.id },
    data: {
      status: dead ? "DEAD" : "FAILED",
      lastError: message.slice(0, 2000),
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
      lockedAt: null,
      lockedBy: null,
      finishedAt: dead ? new Date() : null,
    },
  });
  if (dead) logger.error({ jobId: job.id, type: job.type, err: message }, "Job endgültig fehlgeschlagen (Dead Letter)");
}

export async function releaseStale(minutes = 15): Promise<number> {
  const res = await db().job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - minutes * 60_000) } },
    data: { status: "FAILED", lockedAt: null, lockedBy: null, lastError: "Worker-Abbruch (Neustart?) – wird erneut versucht" },
  });
  return res.count;
}

export type Handler = (payload: Record<string, unknown>) => Promise<void>;

export async function runOnce(handlers: Record<string, Handler>, workerId = `w-${randomUUID().slice(0, 8)}`): Promise<boolean> {
  const job = await claimNext(workerId);
  if (!job) return false;
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`Unbekannter Job-Typ ${job.type}`);
    await handler(job.payload as Record<string, unknown>);
    await complete(job.id);
  } catch (err) {
    logger.warn({ err, jobId: job.id, type: job.type, attempt: job.attempts }, "Job fehlgeschlagen");
    await fail(job, err);
  }
  return true;
}
