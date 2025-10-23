import { buildApp } from "./app.js";

async function start() {
  try {
    const app = await buildApp();

    const port = Number(process.env.PORT) || 5000;

    await app.listen({ port, host: "0.0.0.0" });

    console.log(`Server listening at http://localhost:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
