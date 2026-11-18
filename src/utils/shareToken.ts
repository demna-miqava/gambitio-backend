import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SHARE_TOKEN_LENGTH = 14;
/** What a share token looks like; anything else never reaches the database. */
export const SHARE_TOKEN_PATTERN = /^[0-9A-Za-z]{14}$/;

/**
 * A new share token: 14 letters and digits, about 83 bits from the system's
 * random source, so a link can't be guessed or counted up to. Letters and
 * digits only, so it survives being pasted into any chat or e-mail.
 */
export function newShareToken(): string {
  let token = "";
  while (token.length < SHARE_TOKEN_LENGTH) {
    for (const byte of randomBytes(SHARE_TOKEN_LENGTH * 2)) {
      // 248 = 4 * 62: bytes above it would make the first letters likelier
      if (byte >= 248) continue;
      token += ALPHABET[byte % ALPHABET.length];
      if (token.length === SHARE_TOKEN_LENGTH) break;
    }
  }
  return token;
}
