import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_MAX_LENGTH, chatOffReason, cleanChatText, type ChatAccess } from "../src/game/chatText.js";

// Built from code points so this file holds no invisible characters itself
const cp = (...points: number[]) => String.fromCodePoint(...points);
const text = (raw: string) => {
  const cleaned = cleanChatText(raw);
  assert.equal(cleaned.ok, true, `expected "${raw}" to be accepted`);
  return cleaned.ok ? cleaned.text : "";
};

describe("cleaning chat text", () => {
  test("ordinary text is kept as typed, markup included", () => {
    assert.equal(text("good game!"), "good game!");
    assert.equal(text("<script>alert(1)</script>"), "<script>alert(1)</script>");
    assert.equal(text(`'; DROP TABLE games; --`), `'; DROP TABLE games; --`);
    assert.equal(text(`<img src=x onerror="alert(1)">`), `<img src=x onerror="alert(1)">`);
    assert.equal(text("&lt;b&gt; & \\ \" '"), "&lt;b&gt; & \\ \" '");
  });

  test("whitespace is collapsed and trimmed; line breaks become spaces", () => {
    assert.equal(text("  hello \t\n\r\n  there  "), "hello there");
    assert.equal(text(`a${cp(0x00a0)}${cp(0x2003)}b`), "a b");
    assert.equal(text(`a${cp(0x2028)}b${cp(0x2029)}c`), "a b c");
  });

  test("control characters are removed", () => {
    assert.equal(text(`a${cp(0x0000)}b${cp(0x0007)}c${cp(0x001b)}[31md${cp(0x007f)}${cp(0x009b)}`), "abc[31md");
  });

  test("invisible characters and directional overrides are removed", () => {
    // Zero-width space, word joiner, byte order mark, soft hyphen
    assert.equal(text(`a${cp(0x200b)}b${cp(0x2060)}c${cp(0xfeff)}d${cp(0x00ad)}e`), "abcde");
    // Right-to-left override and its friends, which can make text read as something else
    for (const point of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
      assert.equal(text(`ab${cp(point)}cd`), "abcd", `U+${point.toString(16)}`);
    }
    // The "tag" block, usable to hide text
    assert.equal(text(`hi${cp(0xe0041)}${cp(0xe0042)}${cp(0xe007f)}`), "hi");
  });

  test("emoji sequences survive", () => {
    const family = `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`;
    assert.equal(text(family), family);
    const heart = `${cp(0x2764)}${cp(0xfe0f)}`;
    assert.equal(text(`gg ${heart}`), `gg ${heart}`);
  });

  test("text is normalised to NFC", () => {
    assert.equal(text(`cafe${cp(0x0301)}`), `caf${cp(0x00e9)}`);
  });

  test("stacks of combining marks are cut down", () => {
    const zalgo = `a${cp(0x0300).repeat(40)}b`;
    assert.equal([...text(zalgo)].length <= 6, true);
  });

  test("half a surrogate pair is dropped", () => {
    assert.equal(text(`a${String.fromCharCode(0xd83d)}b`), "ab");
  });

  test("nothing visible is refused", () => {
    for (const raw of ["", "   ", "\n\t", cp(0x200b), cp(0x200d), `${cp(0x202e)} ${cp(0xfeff)}`, cp(0xfe0f)]) {
      assert.deepEqual(cleanChatText(raw), { ok: false, reason: "empty" });
    }
  });

  test("length is counted in characters, after cleaning", () => {
    assert.equal(text("a".repeat(CHAT_MAX_LENGTH)).length, CHAT_MAX_LENGTH);
    assert.deepEqual(cleanChatText("a".repeat(CHAT_MAX_LENGTH + 1)), { ok: false, reason: "too_long" });
    // An emoji is one character though it takes two UTF-16 units
    const emoji = cp(0x1f600);
    assert.equal(cleanChatText(emoji.repeat(CHAT_MAX_LENGTH)).ok, true);
    assert.equal(cleanChatText(emoji.repeat(CHAT_MAX_LENGTH + 1)).ok, false);
    // Padding that is removed doesn't count
    assert.equal(cleanChatText(`${"a".repeat(CHAT_MAX_LENGTH)}${" ".repeat(50)}`).ok, true);
  });
});

describe("who can chat", () => {
  const base: ChatAccess = {
    whiteId: 1,
    blackId: 2,
    status: "in_progress",
    endedAt: null,
    whiteAllows: "everyone",
    blackAllows: "everyone",
    areFriends: false,
  };
  const now = Date.UTC(2026, 0, 1);

  test("both settings must allow the other player", () => {
    assert.equal(chatOffReason(base, 1, now), null);
    assert.equal(chatOffReason({ ...base, whiteAllows: "nobody" }, 1, now), "off_by_you");
    assert.equal(chatOffReason({ ...base, whiteAllows: "nobody" }, 2, now), "off_by_opponent");
    assert.equal(chatOffReason({ ...base, blackAllows: "only_friends" }, 1, now), "off_by_opponent");
    assert.equal(chatOffReason({ ...base, blackAllows: "only_friends", areFriends: true }, 1, now), null);
    // "Nobody" means friends too
    assert.equal(chatOffReason({ ...base, blackAllows: "nobody", areFriends: true }, 2, now), "off_by_you");
  });

  test("the chat stays open for ten minutes after the game", () => {
    const ended = (minutesAgo: number) => ({
      ...base,
      status: "finished",
      endedAt: new Date(now - minutesAgo * 60_000),
    });
    assert.equal(chatOffReason(ended(1), 1, now), null);
    assert.equal(chatOffReason(ended(9.9), 2, now), null);
    assert.equal(chatOffReason(ended(10.1), 1, now), "closed");
    assert.equal(chatOffReason({ ...base, status: "finished", endedAt: null }, 1, now), "closed");
  });
});
