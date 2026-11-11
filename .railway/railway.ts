// Railway Infrastructure as Code für ReviewPilot (Config-as-Code ist abgekündigt).
// Prüfen:   npm run railway:plan     Anwenden: npm run railway:apply (nur nach Durchsicht des Plans)
// Windows: nur aus PowerShell mit $env:_ = Pfad zu railway.exe (Git Bash bricht die CLI-Versionsprüfung).
//
// Nicht hier ausdrückbar (siehe docs/DEPLOYMENT.md): Standardregion des Projekts VOR dem ersten apply auf EU West
// stellen, öffentliche Domain für "web", Werte aller preserve()-Variablen.
import { defineRailway, github, group, postgres, preserve, project, service } from "railway/iac";

const REPO = "adfunture/reviewpilot"; // GitHub-Repo anlegen und ggf. anpassen
const BRANCH = "main";
const EU_REGION = "europe-west4-drams3a";
const EU = { [EU_REGION]: 1 };

export default defineRailway(() => {
  const db = postgres("postgres", { region: EU_REGION });
  const source = github(REPO, { branch: BRANCH });
  const build = { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" };

  const env = {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
    COOKIE_SECURE: "true",
    DATABASE_URL: db.env.DATABASE_URL,
    SHOPIFY_API_VERSION: "2026-10",
    EMAIL_TRANSPORT: "log", // erst nach SMTP-Einrichtung auf "smtp" stellen
    // Werte im Railway-Dashboard setzen (Secrets):
    PUBLIC_BASE_URL: preserve(),
    ENCRYPTION_KEY: preserve(), // node dist/cli.js generate-key – zusätzlich offline sichern!
    SESSION_SECRET: preserve(),
    SHOPIFY_SHOP_DOMAIN: preserve(),
    SHOPIFY_CLIENT_ID: preserve(),
    SHOPIFY_CLIENT_SECRET: preserve(), // bei im Admin erstellter App: „API-Geheimschlüssel“ (shpss_…) für Webhook-Signaturen
    SHOPIFY_ACCESS_TOKEN: preserve(), // nur bei im Admin erstellter App: Admin-API-Zugriffstoken (shpat_…)
    SMTP_HOST: preserve(),
    SMTP_PORT: preserve(),
    SMTP_USER: preserve(),
    SMTP_PASSWORD: preserve(),
    EMAIL_FROM: preserve(),
    EMAIL_REPLY_TO: preserve(),
    BOUNCE_WEBHOOK_SECRET: preserve(),
    // Bleibt bis zur Produktivfreigabe ungesetzt (= false). Nur bewusst auf "true" setzen.
    ALLOW_CUSTOMER_EMAILS: preserve(),
  };

  const web = service("web", {
    source,
    build,
    start: "node dist/server.js",
    // Migrationen + Stammdaten vor jedem Deploy; ein Fehler stoppt das Deployment
    preDeploy: "sh -c 'node node_modules/prisma/build/index.js migrate deploy && node dist/cli.js seed'",
    healthcheck: "/health",
    healthcheckTimeout: 60,
    replicas: EU,
    env: { ...env, PORT: "8080" },
  });

  // Genau eine Worker-Instanz (Queue ist trotzdem mehrinstanzfähig). Alternative für minimale Kosten:
  // Worker-Service weglassen und auf "web" RUN_WORKER_IN_WEB=true setzen.
  const worker = service("worker", {
    source,
    build,
    start: "node dist/worker.js",
    replicas: EU,
    deploy: { restartPolicyType: "ALWAYS", drainingSeconds: 30 },
    env,
  });

  return project("reviewpilot", {
    resources: [web, group("Worker", [worker]), group("Daten", [db])],
  });
});
