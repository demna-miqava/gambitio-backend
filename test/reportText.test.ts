import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanReportDetails, escapeForTerminal, REPORT_DETAILS_MAX_LENGTH } from "../src/services/moderationService.js";

describe("report text", () => {
  test("details lose control and invisible characters but keep their lines", () => {
    assert.equal(cleanReportDetails(undefined), null);
    assert.equal(cleanReportDetails("  ​\u0000 "), null);
    assert.equal(cleanReportDetails("  engine moves  "), "engine moves");
    // An ANSI sequence loses its ESC, so a terminal shows it as text
    assert.equal(cleanReportDetails("\u001b]0;title\u0007\u001b[31mred"), "]0;title[31mred");
    assert.equal(cleanReportDetails("one\r\ntwo\rthree four\t\tfive\n\n\n\nsix"), "one\ntwo\nthree\nfour five\n\nsix");
    // Right-to-left override and zero-width characters
    assert.equal(cleanReportDetails("abc‮def​ghi"), "abcdefghi");
    assert.equal(cleanReportDetails("x".repeat(REPORT_DETAILS_MAX_LENGTH))!.length, REPORT_DETAILS_MAX_LENGTH);
  });

  test("printing escapes whatever could control the terminal", () => {
    assert.equal(escapeForTerminal("\u001b[2Jhi\u0007"), "\\u{1B}[2Jhi\\u{7}");
    assert.equal(escapeForTerminal("a\nb\rc"), "a\\u{A}b\\u{D}c");
    assert.equal(escapeForTerminal("a\nb", { multiline: true }), "a\nb");
    assert.equal(escapeForTerminal("\u009b31m ‮ \u{E0041} \uD800"), "\\u{9B}31m \\u{202E} \\u{E0041} \\u{D800}");
    // Ordinary text, emoji and other scripts are left alone
    assert.equal(escapeForTerminal("Grüße 👍🏽 👨‍👩‍👧 مرحبا"), "Grüße 👍🏽 👨‍👩‍👧 مرحبا");
  });
});
