import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function start() {
  const config = loadConfig();
  const app = await buildApp(config);

  // Close connections and finish in-flight requests on shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "Shutting down");
      app
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          app.log.error({ err }, "Error during shutdown");
          process.exit(1);
        });
    });
  }

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
