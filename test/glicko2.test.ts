import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOLATILITY,
  MAX_RD,
  MIN_RD,
  PROVISIONAL_RD,
  currentRd,
  glicko2,
  isProvisional,
  ratePlayer,
  rdAfterGames,
  type RatingState,
} from "../src/utils/glicko2.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected}`);

test("glicko2 reproduces the worked example of Glickman's paper", () => {
  // "Example of the Glicko-2 system" (2013): tau 0.5, one period, three games
  const after = glicko2(
    { rating: 1500, rd: 200, volatility: 0.06 },
    [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ],
    { tau: 0.5 }
  );
  near(after.rating, 1464.06, 0.01, "rating");
  near(after.rd, 151.52, 0.01, "deviation");
  near(after.volatility, 0.05999, 0.00001, "volatility");
});

test("a period without games only grows the deviation", () => {
  const after = glicko2({ rating: 1500, rd: 200, volatility: 0.06 }, []);
  assert.equal(after.rating, 1500);
  assert.equal(after.volatility, 0.06);
  assert.ok(after.rd > 200);
});

test("a new player stops being provisional after a few handfuls of games", () => {
  let player: RatingState = { rating: 400, rd: MAX_RD, volatility: DEFAULT_VOLATILITY, ratedAt: null };
  assert.ok(isProvisional(player, NOW));
  // Really a 1400 player: beats 1200s, loses to 1600s, alternating
  let games = 0;
  while (isProvisional(player, NOW) && games < 50) {
    const strong = games % 2 === 1;
    const opponent = { rating: strong ? 1600 : 1200, rd: 60, volatility: 0.06, ratedAt: NOW };
    player = ratePlayer(player, opponent, strong ? 0 : 1, NOW);
    games++;
  }
  assert.ok(games >= 5 && games <= 20, `provisional for ${games} games`);
  assert.ok(player.rating > 1150 && player.rating < 1650, `ended at ${Math.round(player.rating)}`);
});

test("the deviation stays between its floor and its ceiling", () => {
  let player: RatingState = { rating: 1500, rd: 60, volatility: 0.06, ratedAt: NOW };
  for (let i = 0; i < 300; i++) {
    player = ratePlayer(player, { rating: 1500, rd: 60, volatility: 0.06, ratedAt: NOW }, i % 2 ? 1 : 0, NOW);
  }
  assert.equal(player.rd, MIN_RD);
  // Even a rating at the floor still moves by a few points a game
  const won = ratePlayer(player, { rating: player.rating, rd: MIN_RD, volatility: 0.06, ratedAt: NOW }, 1, NOW);
  assert.ok(won.rating - player.rating > 4, `gains ${won.rating - player.rating}`);

  const longGone = { rating: 1500, rd: 300, volatility: 0.1, ratedAt: daysAgo(20 * 365) };
  assert.equal(currentRd(longGone, NOW), MAX_RD);
  assert.ok(ratePlayer(longGone, longGone, 1, NOW).rd <= MAX_RD);
});

test("time away makes a settled rating provisional again", () => {
  const at = (days: number): RatingState => ({ rating: 1500, rd: 60, volatility: 0.06, ratedAt: daysAgo(days) });
  near(currentRd(at(0), NOW), 60, 1e-9, "deviation today");
  assert.ok(!isProvisional(at(30), NOW));
  assert.ok(!isProvisional(at(300), NOW));
  near(currentRd(at(365), NOW), PROVISIONAL_RD, 2, "deviation after a year");
  assert.ok(isProvisional(at(500), NOW));
  // A rating that was never played for has nothing to grow from
  near(currentRd({ rating: 1500, rd: 80, volatility: 0.06, ratedAt: null }, NOW), 80, 1e-9, "never played");
});

test("a player back from a long break moves more than one who never left", () => {
  const opponent = { rating: 1500, rd: 60, volatility: 0.06, ratedAt: NOW };
  const active = ratePlayer({ rating: 1500, rd: 60, volatility: 0.06, ratedAt: NOW }, opponent, 1, NOW);
  const returning = ratePlayer({ rating: 1500, rd: 60, volatility: 0.06, ratedAt: daysAgo(400) }, opponent, 1, NOW);
  assert.ok(returning.rating > active.rating);
  // And the other way round: a win over someone long gone counts for less
  const overStale = ratePlayer(
    { rating: 1500, rd: 60, volatility: 0.06, ratedAt: NOW },
    { ...opponent, ratedAt: daysAgo(400) },
    1,
    NOW
  );
  assert.ok(overStale.rating < active.rating);
});

test("rdAfterGames matches the backfill in migration 032", async () => {
  assert.equal(rdAfterGames(0), MAX_RD);
  near(rdAfterGames(10), 105, 1, "after 10 games");
  near(rdAfterGames(20), 76, 1, "after 20 games");
  assert.equal(rdAfterGames(50), MIN_RD);
  assert.equal(rdAfterGames(5_000), MIN_RD);
  // The migration inlines the same formula as numbers
  const q = Math.LN10 / 400;
  near((q * q) / 4, 0.0000082842, 1e-10, "games coefficient");
  assert.equal(MAX_RD * MAX_RD, 122500);
});
