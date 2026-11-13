import { defineConfig } from "vitest/config";

// Tests laufen gegen ein echtes Postgres (PGlite über Socket, siehe tools/testdb) – kein Docker nötig.
export const TEST_DB_PORT = 54330;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // eine gemeinsame Datenbank → sequentiell
    testTimeout: 30000,
    hookTimeout: 120000,
    globalSetup: ["test/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@127.0.0.1:${TEST_DB_PORT}/postgres?connection_limit=1&pgbouncer=true&sslmode=disable`,
      PUBLIC_BASE_URL: "https://reviews.example.test",
      SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      SHOPIFY_SHOP_DOMAIN: "test-shop.myshopify.com",
      SHOPIFY_CLIENT_ID: "test-client",
      SHOPIFY_CLIENT_SECRET: "test-secret",
      EMAIL_TRANSPORT: "log",
      ALLOW_CUSTOMER_EMAILS: "true",
      SEND_STAGGER_SECONDS: "0",
    },
  },
});
