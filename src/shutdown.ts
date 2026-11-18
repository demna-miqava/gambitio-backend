import type { FastifyInstance } from "fastify";

/** Just what the shutdown handler uses of `process`, so tests can pass a fake. */
export interface ShutdownProcess {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exit(code: number): void;
}

/**
 * Close connections and finish in-flight requests on SIGINT / SIGTERM.
 * First, while the players' sockets are still open, pause the games they
 * are playing here, so a deploy or restart isn't charged to anyone's clock
 * (LiveGameService.pauseForShutdown). A failure there must not stop the
 * shutdown. A crash or SIGKILL skips all of this: those games lose the
 * downtime.
 *
 * The handler stays installed (`on`, not `once`) and ignores every signal
 * after the first: several senders (the Worker's isolates, see
 * worker/index.ts) can each signal, and with `once` a second signal would
 * get Node's default action and kill the process mid-shutdown, possibly
 * before the pause is written.
 */
export function installShutdownHandlers(
  app: Pick<FastifyInstance, "log" | "liveGames" | "close">,
  proc: ShutdownProcess = process
): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    proc.on(signal, () => {
      if (shuttingDown) {
        app.log.info({ signal }, "Shutdown already in progress; ignoring the signal");
        return;
      }
      shuttingDown = true;
      app.log.info({ signal }, "Shutting down");
      app.liveGames
        .pauseForShutdown()
        .catch((err) => app.log.error({ err }, "Pausing games for shutdown failed"))
        .then(() => app.close())
        .then(() => proc.exit(0))
        .catch((err) => {
          app.log.error({ err }, "Error during shutdown");
          proc.exit(1);
        });
    });
  }
}
