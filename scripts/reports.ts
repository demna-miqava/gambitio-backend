/**
 * Reviews player reports (migration 028). There is no moderation screen in
 * the app; this is how reports are read and closed.
 *
 *   npm run reports                    open reports, oldest first
 *   npm run reports -- all             every report, newest first (latest 200)
 *   npm run reports -- show 12         one report in full, with its chat excerpt (a game's or a study room's)
 *   npm run reports -- resolve 12      close it as acted on
 *   npm run reports -- dismiss 12      close it as not a problem
 *
 * Reads POSTGRES_CONNECTION_STRING.
 *
 * Everything players wrote (details, chat, usernames) goes through `safe`
 * before it is printed, so a report can't send escape sequences to the
 * terminal of whoever reads it.
 */
import pg from "pg";
import { escapeForTerminal } from "../src/services/moderationService.js";

const safe = (value: unknown) => escapeForTerminal(String(value ?? ""));
/** Multi-line text, each line indented by `indent` */
const safeBlock = (value: string, indent: string) =>
  escapeForTerminal(value, { multiline: true }).replace(/\n/g, `\n${indent}`);

const [command = "open", arg] = process.argv.slice(2);
const connectionString = process.env.POSTGRES_CONNECTION_STRING;
if (!connectionString) {
  console.error("POSTGRES_CONNECTION_STRING is not set");
  process.exit(1);
}

const LIST_SQL = (where: string, order: string) => `
  SELECT r.id, r."createdAt", r.status, r.reason, r."gameId", r."studyRoomId", r.details,
         reporter.username AS reporter, reported.username AS reported, r."reportedId",
         (SELECT COUNT(*) FROM user_reports o WHERE o."reportedId" = r."reportedId") AS "reportsOfPlayer",
         (SELECT COUNT(DISTINCT o."reporterId") FROM user_reports o WHERE o."reportedId" = r."reportedId")
           AS "reporters"
  FROM user_reports r
  JOIN users reporter ON reporter.id = r."reporterId"
  JOIN users reported ON reported.id = r."reportedId"
  ${where} ORDER BY ${order} LIMIT 200`;

const client = new pg.Client({ connectionString });
await client.connect();
try {
  if (command === "open" || command === "all") {
    const { rows } = await client.query(
      command === "open"
        ? LIST_SQL(`WHERE r.status = 'open'`, `r."createdAt"`)
        : LIST_SQL("", `r."createdAt" DESC`)
    );
    if (rows.length === 0) console.log(command === "open" ? "No open reports." : "No reports.");
    for (const r of rows) {
      console.log(
        `#${r.id}  ${r.createdAt.toISOString().slice(0, 16)}  ${r.status.padEnd(9)} ${safe(r.reason).padEnd(14)} ` +
          `${safe(r.reported)} (id ${r.reportedId}; ${r.reportsOfPlayer} report(s) from ${r.reporters} player(s))` +
          `  by ${safe(r.reporter)}` +
          (r.gameId ? `  game ${r.gameId}` : "") +
          (r.studyRoomId ? `  study room ${r.studyRoomId}` : "") +
          (r.details ? `\n      ${safe(r.details.replace(/\s+/g, " "))}` : "")
      );
    }
  } else if (command === "show" || command === "resolve" || command === "dismiss") {
    const id = Number(arg);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Usage: npm run reports -- ${command} <report id>`);
    if (command !== "show") {
      const { rowCount } = await client.query(
        `UPDATE user_reports SET status = $2, "resolvedAt" = now() WHERE id = $1`,
        [id, command === "resolve" ? "resolved" : "dismissed"]
      );
      console.log(rowCount ? `Report #${id} ${command === "resolve" ? "resolved" : "dismissed"}.` : `No report #${id}.`);
    } else {
      const { rows } = await client.query(
        `SELECT r.*, reporter.username AS reporter, reported.username AS reported
         FROM user_reports r
         JOIN users reporter ON reporter.id = r."reporterId"
         JOIN users reported ON reported.id = r."reportedId"
         WHERE r.id = $1`,
        [id]
      );
      const r = rows[0];
      if (!r) {
        console.log(`No report #${id}.`);
      } else {
        console.log(`Report #${r.id} (${r.status}), ${r.createdAt.toISOString()}`);
        console.log(
          `  ${safe(r.reporter)} (id ${r.reporterId}) reported ${safe(r.reported)} (id ${r.reportedId}) for ${safe(r.reason)}`
        );
        if (r.gameId) console.log(`  Game ${r.gameId}`);
        // Migration 041; a room that was deleted since is no longer named
        if (r.studyRoomId) console.log(`  Study room ${r.studyRoomId}`);
        if (r.details) console.log(`  Details: ${safeBlock(r.details, "           ")}`);
        const chat: { userId: number; text: string; at: string }[] = r.chatExcerpt ?? [];
        if (chat.length > 0) {
          console.log(r.studyRoomId ? "  Chat in that study room:" : "  Chat in that game:");
          for (const m of chat) {
            const who = m.userId === r.reportedId ? r.reported : m.userId === r.reporterId ? r.reporter : m.userId;
            console.log(`    [${safe(m.at)}] ${safe(who)}: ${safe(m.text)}`);
          }
        }
      }
    }
  } else {
    throw new Error(`Unknown command "${command}". Use open, all, show, resolve or dismiss.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
