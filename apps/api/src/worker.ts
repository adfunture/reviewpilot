import { disconnectDb } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { startWorker, stopWorker } from "./jobs/loop.js";

// Einstiegspunkt des Worker-Service (Railway: "worker")
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    logger.info("Worker wird beendet");
    stopWorker();
    setTimeout(() => {
      void disconnectDb().finally(() => process.exit(0));
    }, 2000);
  });
}
startWorker().catch((err) => {
  logger.fatal({ err }, "Worker-Start fehlgeschlagen");
  process.exit(1);
});
