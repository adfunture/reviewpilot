import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { sign, unsign, verifyPassword } from "../lib/crypto.js";
import { db } from "../lib/db.js";

export const SESSION_COOKIE = "rp_session";
const SESSION_HOURS = 12;

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; shopId: string; role: string; email: string };
  }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  const value = token ? unsign(token, "session") : null;
  const [userId, exp] = value?.split("|") ?? [];
  if (!userId || !exp || Number(exp) < Date.now()) {
    await reply.code(401).send({ error: "Nicht angemeldet" });
    return;
  }
  const user = await db().user.findUnique({ where: { id: userId } });
  if (!user) {
    await reply.code(401).send({ error: "Nicht angemeldet" });
    return;
  }
  req.user = { id: user.id, shopId: user.shopId, role: user.role, email: user.email };
}

export function requireWrite(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (req.user?.role === "VIEWER") {
    void reply.code(403).send({ error: "Keine Berechtigung" });
    return;
  }
  done();
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
      const user = await db().user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
        return reply.code(401).send({ error: "E-Mail oder Passwort falsch" });
      }
      await db().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      const token = sign(`${user.id}|${Date.now() + SESSION_HOURS * 3600_000}`, "session");
      reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", secure: config().COOKIE_SECURE, path: "/", maxAge: SESSION_HOURS * 3600 });
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}
