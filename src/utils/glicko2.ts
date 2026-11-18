/**
 * Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013), applied one
 * game at a time.
 *
 * A player has three numbers per time control:
 * - rating: the estimate of their strength
 * - rd (rating deviation): how unsure that estimate is. A new player starts
 *   at MAX_RD and each game brings it down; time without playing brings it
 *   back up
 * - volatility: how erratic their results have been
 *
 * A game moves a rating by an amount that grows with the player's own rd and
 * shrinks with the opponent's: a newcomer reaches their level in a handful of
 * games, and an established player loses little to a newcomer whose rating
 * says nothing yet. The two changes are not equal and opposite.
 *
 * The paper rates a whole "rating period" of games at once and grows every
 * deviation once per period. Here each game is rated as it ends, and the
 * deviation grows with the time since the player's previous rated game,
 * counted as a fraction of a period (RATING_PERIODS_PER_DAY), the way
 * Lichess runs it.
 */

/** Glicko-2's internal scale: 173.7178 rating points per unit. */
const SCALE = 173.7178;
/**
 * How strongly volatility resists change (the paper suggests 0.3 to 1.2).
 * Mid-range: one surprising result doesn't swing it.
 */
const TAU = 0.75;
/** Convergence tolerance of the volatility iteration */
const EPSILON = 0.000001;

/** The deviation of a player who has never played */
export const MAX_RD = 350;
/**
 * Deviations never go below this, so a long-established rating still moves
 * (about 7 points for a game between equals) and a player who improves isn't
 * stuck.
 */
export const MIN_RD = 50;
/** A rating with a deviation above this is provisional (shown with a "?"). */
export const PROVISIONAL_RD = 110;
export const DEFAULT_VOLATILITY = 0.06;
const MIN_VOLATILITY = 0.01;
const MAX_VOLATILITY = 0.1;
/**
 * Rating periods per day without a rated game. At the default volatility a
 * deviation of 60 grows back to PROVISIONAL_RD after about a year away.
 */
export const RATING_PERIODS_PER_DAY = 0.21436;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RatingState {
  rating: number;
  rd: number;
  volatility: number;
  /** The player's last rated game in this time control; null before the first */
  ratedAt: Date | null;
}

export type GameScore = 0 | 0.5 | 1;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Rating periods between the player's last rated game and `now`. */
function periodsSince(ratedAt: Date | null, now: Date): number {
  if (!ratedAt) return 0;
  return Math.max(0, (now.getTime() - ratedAt.getTime()) / DAY_MS) * RATING_PERIODS_PER_DAY;
}

/**
 * The deviation as of `now`: the stored one, grown by the time since the
 * player's last rated game (it is only written when they play).
 */
export function currentRd(player: RatingState, now: Date): number {
  const phi = player.rd / SCALE;
  const sigma = clamp(player.volatility, MIN_VOLATILITY, MAX_VOLATILITY);
  const grown = Math.sqrt(phi * phi + periodsSince(player.ratedAt, now) * sigma * sigma);
  return clamp(grown * SCALE, MIN_RD, MAX_RD);
}

export function isProvisional(player: RatingState, now: Date): boolean {
  return currentRd(player, now) > PROVISIONAL_RD;
}

/** How much an opponent's result counts, given how unsure their rating is. */
const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/** Step 5 of the paper: the new volatility, by the Illinois method. */
function newVolatility(phi: number, sigma: number, delta: number, v: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const top = ex * (delta * delta - phi * phi - v - ex);
    const bottom = 2 * (phi * phi + v + ex) ** 2;
    return top / bottom - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  // Converges in a handful of steps; the cap only guards against a NaN
  for (let i = 0; i < 100 && Math.abs(B - A) > EPSILON; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

export interface Glicko2Player {
  rating: number;
  rd: number;
  volatility: number;
}

/**
 * The paper's algorithm, steps 2 to 8, with nothing of ours added: a
 * player's numbers after the `results` of one rating period. `periods` is
 * how many periods the deviation grows by (1 in the paper). Exported so a
 * test can check it against the paper's worked example; ratePlayer is what
 * the app uses.
 */
export function glicko2(
  player: Glicko2Player,
  results: { rating: number; rd: number; score: GameScore }[],
  { tau = TAU, periods = 1 }: { tau?: number; periods?: number } = {}
): Glicko2Player {
  const mu = player.rating / SCALE;
  const phi = player.rd / SCALE;

  let vInverse = 0;
  let outcome = 0;
  for (const result of results) {
    const gj = g(result.rd / SCALE);
    const expected = 1 / (1 + Math.exp(-gj * (mu - result.rating / SCALE)));
    vInverse += gj * gj * expected * (1 - expected);
    outcome += gj * (result.score - expected);
  }
  // No games: only the deviation grows
  if (vInverse === 0) {
    const grown = Math.sqrt(phi * phi + periods * player.volatility ** 2);
    return { rating: player.rating, rd: grown * SCALE, volatility: player.volatility };
  }
  const v = 1 / vInverse;
  const volatility = newVolatility(phi, player.volatility, v * outcome, v, tau);
  const grown = Math.sqrt(phi * phi + periods * volatility * volatility);
  const newPhi = 1 / Math.sqrt(1 / (grown * grown) + 1 / v);
  return {
    rating: (mu + newPhi * newPhi * outcome) * SCALE,
    rd: newPhi * SCALE,
    volatility,
  };
}

/**
 * One player's numbers after a game against `opponent`. `score` is the
 * player's own result. The rating is not rounded here.
 */
export function ratePlayer(
  player: RatingState,
  opponent: RatingState,
  score: GameScore,
  now: Date
): RatingState {
  const updated = glicko2(
    {
      rating: player.rating,
      // As of today: the time away counts before the game does
      rd: currentRd(player, now),
      volatility: clamp(player.volatility, MIN_VOLATILITY, MAX_VOLATILITY),
    },
    // The opponent as they stand today too: one who hasn't played in a year
    // is less certain than their stored deviation says
    [{ rating: opponent.rating, rd: currentRd(opponent, now), score }],
    // The deviation grows with time, not with games (currentRd has added
    // the time already): someone playing fifty games in an evening would
    // otherwise keep theirs up by playing
    { periods: 0 }
  );
  return {
    rating: updated.rating,
    rd: clamp(updated.rd, MIN_RD, MAX_RD),
    volatility: clamp(updated.volatility, MIN_VOLATILITY, MAX_VOLATILITY),
    ratedAt: now,
  };
}

/**
 * The deviation to give a player who already has `games` rated games from
 * before deviations were tracked (migration 032): what MAX_RD comes down to
 * after that many games between equals. As SQL, for the migration's backfill
 * and nothing else; kept here so the constants live in one place.
 *
 *   1/rd² = 1/MAX_RD² + games · (ln10/400)² / 4
 */
export function rdAfterGames(games: number): number {
  const q = Math.LN10 / 400;
  return clamp(1 / Math.sqrt(1 / (MAX_RD * MAX_RD) + (Math.max(0, games) * q * q) / 4), MIN_RD, MAX_RD);
}

/**
 * SQL for "is this rating provisional right now", over a users row with the
 * given deviation, volatility and last-rated columns (see currentRd). The
 * column names come from ratingColumns, a fixed map, so they are safe to
 * inline.
 */
export function provisionalSql(columns: { rd: string; volatility: string; ratedAt: string }): string {
  const perSecond = (SCALE * SCALE * RATING_PERIODS_PER_DAY) / (DAY_MS / 1000);
  return `(sqrt("${columns.rd}" * "${columns.rd}"
      + ${perSecond} * "${columns.volatility}" * "${columns.volatility}"
        * GREATEST(0, COALESCE(EXTRACT(EPOCH FROM now() - "${columns.ratedAt}"), 0))) > ${PROVISIONAL_RD})`;
}
