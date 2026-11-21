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
 *
 * A shutdown that hasn't finished after SHUTDOWN_TIMEOUT_MS (a socket that
 * never answers the close, a stuck query) exits anyway, with code 1, rather
 * than waiting to be killed. The pause comes first, so normally it is only
 * the rest of the cleanup that is cut short.
 */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

export function installShutdownHandlers(
  app: Pick<FastifyInstance, "log" | "liveGames" | "close">,
  proc: ShutdownProcess = process,
  timeoutMs = SHUTDOWN_TIMEOUT_MS
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
      // Inside the 10 s an old backend is given before it is killed (worker/index.ts)
      const watchdog = setTimeout(() => {
        app.log.error({ timeoutMs }, "Shutdown took too long; exiting");
        proc.exit(1);
      }, timeoutMs);
      // Never what keeps the process alive once everything else has closed
      watchdog.unref();
      app.liveGames
        .pauseForShutdown()
        .catch((err) => app.log.error({ err }, "Pausing games for shutdown failed"))
        .then(() => app.close())
        .then(() => proc.exit(0))
        .catch((err) => {
          app.log.error({ err }, "Error during shutdown");
          proc.exit(1);
        })
        .finally(() => clearTimeout(watchdog));
    });
  }
}
