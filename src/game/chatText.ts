/**
 * Cleaning of chat messages before they are stored.
 *
 * The text is kept as typed otherwise: it is NOT HTML-escaped here. It is
 * data, bound as a query parameter on the way into the database and rendered
 * as a text node by the client; escaping belongs where text is displayed.
 */

/** Longest message, in characters (code points), after cleaning */
export const CHAT_MAX_LENGTH = 200;
/** Longest raw message a client may send (UTF-16 units), before cleaning */
export const CHAT_MAX_RAW_LENGTH = 500;

// Half of a surrogate pair on its own (not valid text)
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;
/**
 * Characters nobody can see that change how the rest is read or shown:
 * control characters (C0, DEL, C1), the soft hyphen, zero-width space and
 * word joiner, directional marks, embeddings, overrides and isolates (which
 * can reorder text so it reads as something else), invisible operators, the
 * byte order mark, annotation marks and the "tag" block. The zero-width
 * joiner and non-joiner stay: emoji sequences and several scripts need them.
 */
const INVISIBLE =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;
// More than this many combining marks on one character is decoration that
// spills over the lines above and below ("zalgo")
const EXCESS_MARKS = /(\p{M}{3})\p{M}+/gu;
// Something a reader can see: not whitespace, a joiner or a variation selector
const VISIBLE = /[^\s\u200C\u200D\uFE00-\uFE0F]/u;

export type CleanedChatText = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" };

/** Characters (code points) in a string: what the length limit counts */
export const chatLength = (text: string): number => [...text].length;

/**
 * Normalises text (NFC) and removes lone surrogates, invisible and control
 * characters (see INVISIBLE; tabs and line breaks stay) and excess combining
 * marks. Also used for other text players write (report details).
 */
export function stripInvisibleText(raw: string): string {
  return raw.replace(LONE_SURROGATES, "").normalize("NFC").replace(INVISIBLE, "").replace(EXCESS_MARKS, "$1");
}

/**
 * Normalises a message (NFC), removes invisible and control characters,
 * turns every run of whitespace (line breaks included) into one space and
 * trims. Refuses what is then empty or longer than CHAT_MAX_LENGTH.
 */
export function cleanChatText(raw: string): CleanedChatText {
  const text = stripInvisibleText(raw).replace(/\s+/gu, " ").trim();
  if (!VISIBLE.test(text)) return { ok: false, reason: "empty" };
  if (chatLength(text) > CHAT_MAX_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

export type ChatAllowedFrom = "everyone" | "only_friends" | "nobody";

/**
 * Why a game has no chat for a player, or null if it does. "blocked": the
 * player blocked their opponent. Being blocked reads as "off_by_opponent",
 * so a block is never revealed to the blocked player.
 */
export type ChatOffReason = "off_by_you" | "off_by_opponent" | "blocked" | "closed";

/** How long after a game ends its players can still write */
export const CHAT_OPEN_AFTER_END_MS = 10 * 60_000;

export interface ChatAccess {
  whiteId: number;
  blackId: number;
  status: string;
  endedAt: Date | null;
  whiteAllows: ChatAllowedFrom;
  blackAllows: ChatAllowedFrom;
  areFriends: boolean;
  /** Blocks between the two players (migration 028) */
  whiteBlockedBlack?: boolean;
  blackBlockedWhite?: boolean;
}

const allows = (setting: ChatAllowedFrom, areFriends: boolean) =>
  setting === "everyone" || (setting === "only_friends" && areFriends);

/**
 * Whether a player can write in their game's chat right now. Neither may
 * have blocked the other and both players' settings must allow the other;
 * the chat closes a while after the game.
 * Call only for one of the two players.
 */
export function chatOffReason(access: ChatAccess, viewerId: number, now: number): ChatOffReason | null {
  const viewerIsWhite = viewerId === access.whiteId;
  const own = viewerIsWhite ? access.whiteAllows : access.blackAllows;
  const theirs = viewerIsWhite ? access.blackAllows : access.whiteAllows;
  if (viewerIsWhite ? access.whiteBlockedBlack : access.blackBlockedWhite) return "blocked";
  if (viewerIsWhite ? access.blackBlockedWhite : access.whiteBlockedBlack) return "off_by_opponent";
  if (!allows(own, access.areFriends)) return "off_by_you";
  if (!allows(theirs, access.areFriends)) return "off_by_opponent";
  if (access.status !== "in_progress") {
    if (!access.endedAt || now - access.endedAt.getTime() > CHAT_OPEN_AFTER_END_MS) return "closed";
  }
  return null;
}
