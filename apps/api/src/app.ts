import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { db } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { publicRoutes } from "./routes/public.js";

export async function buildApp(opts: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, routerOptions: { maxParamLength: 500 } }) as unknown as FastifyInstance;

  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Ungültige Eingabe", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "Fehler");
    return reply.code(status).send({ error: status >= 500 ? "Interner Fehler" : err.message });
  });

  app.get("/health", async (_req, reply) => {
    try {
      await db().$queryRaw`SELECT 1`;
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(async (scope) => adminRoutes(scope));

  // Statisches Dashboard (Next.js-Export), gleicher Origin → kein CORS nötig
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (opts.serveWeb !== false && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    // Saubere URLs (/bestellungen → bestellungen.html)
    for (const file of readdirSync(publicDir)) {
      if (!file.endsWith(".html") || file === "index.html") continue;
      const page = file.slice(0, -5);
      app.get(`/${page}`, (_req, reply) => reply.type("text/html").sendFile(file));
    }
    // Next-16-Export legt RSC-Segmente als Unterordner ab, der Client fragt sie mit Punkt-Notation an
    app.get<{ Params: { page: string; file: string } }>("/:page/:file", (req, reply) => {
      const m = /^__next\.([\w-]+)\.(__PAGE__\.txt)$/.exec(req.params.file);
      const target = m && m[1] === req.params.page ? join(req.params.page, `__next.${m[1]}`, m[2]!) : null;
      if (!target || !existsSync(join(publicDir, target))) return reply.code(404).send({ error: "Nicht gefunden" });
      return reply.type("text/x-component").sendFile(target);
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Nicht gefunden" });
      return reply.code(404).type("text/html").sendFile("404.html");
    });
  }
  return app;
}
