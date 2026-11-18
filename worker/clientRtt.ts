/**
 * The TCP round trip Cloudflare measured to the browser, passed to the
 * backend on game WebSocket handshakes for lag compensation (see
 * src/routes/ws/rttProbe.ts). Kept apart from index.ts, with no Cloudflare
 * imports, so the tests can run it.
 */
export const CLIENT_RTT_HEADER = "x-gambitio-client-rtt";

/** Paths whose handshake carries the round trip: a live game's socket. */
const GAME_SOCKET = /^\/api\/ws\/game\/\d+/;

/**
 * The headers to send the backend instead of the request's own, or null to
 * send the request unchanged. A client's own CLIENT_RTT_HEADER is always
 * dropped (only Cloudflare's measurement may reach the backend); a game
 * socket's handshake gets `clientTcpRtt` (request.cf.clientTcpRtt) when it
 * is a positive number.
 */
export function backendHeaders(url: string, headers: Headers, clientTcpRtt: unknown): Headers | null {
  const isGameSocket = GAME_SOCKET.test(new URL(url).pathname);
  const rtt =
    isGameSocket && typeof clientTcpRtt === "number" && Number.isFinite(clientTcpRtt) && clientTcpRtt > 0
      ? clientTcpRtt
      : undefined;
  if (rtt === undefined && !headers.has(CLIENT_RTT_HEADER)) return null;
  const next = new Headers(headers);
  next.delete(CLIENT_RTT_HEADER);
  if (rtt !== undefined) next.set(CLIENT_RTT_HEADER, String(Math.round(rtt)));
  return next;
}
