import { buildApp } from "./app.js";
import { config } from "./config.js";
import { disconnectDb } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { startWorker, stopWorker } from "./jobs/loop.js";

const c = config();
const app = await buildApp();
await app.listen({ host: "0.0.0.0", port: c.PORT });

// Optional: Worker im selben Prozess (spart einen Railway-Service bei kleinen Shops)
if (c.RUN_WORKER_IN_WEB) void startWorker();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    logger.info("Server wird beendet");
    stopWorker();
    await app.close();
    await disconnectDb();
    process.exit(0);
  });
}
