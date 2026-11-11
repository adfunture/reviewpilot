// Kopiert den statischen Export (out/) nach apps/api/public, damit Fastify ihn ausliefert.
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const target = resolve(import.meta.dirname, "../../api/public");
rmSync(target, { recursive: true, force: true });
cpSync(resolve(import.meta.dirname, "../out"), target, { recursive: true });
console.log(`Dashboard nach ${target} kopiert`);
