import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";

const PORT = 54330;
let server: ChildProcess | undefined;

function portOpen(): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ port: PORT, host: "127.0.0.1" }, () => {
      s.end();
      res(true);
    });
    s.on("error", () => res(false));
  });
}

export async function setup(): Promise<void> {
  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres?connection_limit=1&pgbouncer=true&sslmode=disable`;
  if (!process.env.TEST_DATABASE_URL && !(await portOpen())) {
    const bin = resolve(__dirname, "../../../tools/testdb/node_modules/@electric-sql/pglite-socket/dist/scripts/server.js");
    if (!existsSync(bin)) throw new Error(`PGlite-Server fehlt – bitte "npm install --prefix tools/testdb" ausführen (${bin})`);
    server = spawn(process.execPath, [bin, `--port=${PORT}`, "--db=memory://", "--max-connections=4"], { stdio: "ignore" });
    for (let i = 0; i < 100 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const prisma = join(__dirname, "..", "node_modules", "prisma", "build", "index.js");
  execFileSync(process.execPath, [prisma, "migrate", "deploy"], {
    cwd: join(__dirname, ".."),
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL ?? url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "inherit",
  });
}

export async function teardown(): Promise<void> {
  server?.kill();
}
