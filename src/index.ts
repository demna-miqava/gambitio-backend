import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { installShutdownHandlers } from "./shutdown.js";

async function start() {
  const config = loadConfig();
  const app = await buildApp(config);

  // Pause the games played here, then close (src/shutdown.ts)
  installShutdownHandlers(app);

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
