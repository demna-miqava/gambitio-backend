/**
 * Link previews for shared games (/share/<token>). The site is a
 * single-page app: every address gets the same index.html, so a chat app or
 * social network unfurling a share link would only ever see "Gambitio". For
 * these addresses the Worker asks the backend for the game and writes its
 * players and result into the page's <head> before sending it.
 *
 * Kept apart from index.ts, with no Cloudflare imports, so the tests can run
 * it.
 */

/** A share page's address; the token is what src/utils/shareToken.ts makes. */
const SHARE_PATH = /^\/share\/([0-9A-Za-z]{14})\/?$/;

export function shareTokenFromPath(pathname: string): string | null {
  return SHARE_PATH.exec(pathname)?.[1] ?? null;
}

/** The fields of GET /api/shared-games/:token the preview is written from. */
export interface SharedGame {
  time: number | null;
  increment: number;
  type: string | null;
  result: string | null;
  endReason: string | null;
  numMoves: number;
  botId: string | null;
  whitePlayer: { username: string; rating: number };
  blackPlayer: { username: string; rating: number };
}

const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The response body as a SharedGame, or null if it doesn't look like one. */
export function parseSharedGame(body: unknown): SharedGame | null {
  if (typeof body !== "object" || body === null) return null;
  const game = body as Record<string, unknown>;
  const player = (value: unknown) => {
    if (typeof value !== "object" || value === null) return null;
    const { username, rating } = value as Record<string, unknown>;
    const name = text(username, 100);
    const elo = count(rating);
    return name !== null && elo !== null ? { username: name, rating: elo } : null;
  };
  const whitePlayer = player(game.whitePlayer);
  const blackPlayer = player(game.blackPlayer);
  const numMoves = count(game.numMoves);
  if (!whitePlayer || !blackPlayer || numMoves === null) return null;
  return {
    time: count(game.time),
    increment: count(game.increment) ?? 0,
    type: text(game.type, 20),
    result: text(game.result, 20),
    endReason: text(game.endReason, 40),
    numMoves,
    botId: text(game.botId, 40),
    whitePlayer,
    blackPlayer,
  };
}

const SCORES: Record<string, string> = { white_win: "1-0", black_win: "0-1", draw: "½-½" };

const END_REASONS: Record<string, string> = {
  checkmate: "by checkmate",
  resignation: "by resignation",
  timeout: "on time",
  timeout_vs_insufficient_material: "on time against insufficient material",
  stalemate: "by stalemate",
  insufficient_material: "by insufficient material",
  threefold_repetition: "by repetition",
  fifty_move_rule: "by the fifty-move rule",
  draw_agreement: "by agreement",
};

/** "3+2", "10+0", "0.5+0": minutes plus the increment in seconds. */
function clockLabel(time: number, increment: number): string {
  return `${Number((time / 60).toFixed(2))}+${increment}`;
}

export interface ShareMeta {
  title: string;
  description: string;
}

/** The preview's two lines: who played and how it went. */
export function describeSharedGame(game: SharedGame): ShareMeta {
  const { whitePlayer: white, blackPlayer: black } = game;
  const score = game.result ? SCORES[game.result] : undefined;
  const title = `${white.username} (${white.rating}) vs ${black.username} (${black.rating})${
    score ? ` · ${score}` : ""
  }`;

  const how = game.endReason ? END_REASONS[game.endReason] : undefined;
  const outcome =
    game.result === "white_win"
      ? `${white.username} won${how ? ` ${how}` : ""}`
      : game.result === "black_win"
        ? `${black.username} won${how ? ` ${how}` : ""}`
        : game.result === "draw"
          ? `Draw${how ? ` ${how}` : ""}`
          : null;
  const fullMoves = Math.ceil(game.numMoves / 2);
  const kind = game.botId
    ? "Game against a bot"
    : game.time !== null
      ? `${game.type ? `${game.type[0]!.toUpperCase()}${game.type.slice(1)} ` : ""}${clockLabel(game.time, game.increment)}`
      : null;
  const description = [
    outcome && fullMoves > 0 ? `${outcome} in ${fullMoves} move${fullMoves === 1 ? "" : "s"}` : outcome,
    kind,
    "Replay the game on Gambitio",
  ]
    .filter(Boolean)
    .join(" · ");
  return { title, description };
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * index.html with a share page's <head>: always "noindex" (a shared game is
 * for the people it was sent to, not for search results), and the game's
 * title, description and Open Graph / Twitter tags when there is a game.
 * `url` is the page's own address and `image` an absolute image URL.
 * Everything from the game is escaped: usernames are players' text.
 */
export function withShareMeta(
  html: string,
  page: { url: string; image: string; meta: ShareMeta | null }
): string {
  const tags = ['<meta name="robots" content="noindex" />'];
  let out = html;
  if (page.meta) {
    const title = escapeHtml(page.meta.title);
    const description = escapeHtml(page.meta.description);
    // A function, so "$&" and the like in a username are text, not a pattern
    out = out
      .replace(/<title>[^<]*<\/title>/i, () => `<title>${title} · Gambitio</title>`)
      .replace(/<meta\s+name="description"[^>]*>\s*/i, "");
    tags.push(
      `<meta name="description" content="${description}" />`,
      '<meta property="og:type" content="website" />',
      '<meta property="og:site_name" content="Gambitio" />',
      `<meta property="og:title" content="${title}" />`,
      `<meta property="og:description" content="${description}" />`,
      `<meta property="og:url" content="${escapeHtml(page.url)}" />`,
      `<meta property="og:image" content="${escapeHtml(page.image)}" />`,
      '<meta name="twitter:card" content="summary" />',
      `<meta name="twitter:title" content="${title}" />`,
      `<meta name="twitter:description" content="${description}" />`,
      `<meta name="twitter:image" content="${escapeHtml(page.image)}" />`
    );
  }
  const block = `${tags.join("\n    ")}\n  `;
  return /<\/head>/i.test(out) ? out.replace(/<\/head>/i, () => `${block}</head>`) : out;
}
