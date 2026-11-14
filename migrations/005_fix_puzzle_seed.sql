-- Migration 003 seeded starter puzzles whose solutions were wrong (none of the
-- "mate" puzzles ended in mate; 00008 was an unconverted Lichess row). Remove
-- them by exact content so real Lichess puzzles sharing those ids survive.
DELETE FROM puzzles WHERE (id, fen, moves) IN (
  ('00008', 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24', 'f2g3 e6e7 b2b1'),
  ('0000D', '5rk1/1p3ppp/pq3b2/8/8/1P1Q1N2/P4PPP/3R2K1 w - - 2 27', 'd3d6 f8d8 d6d8 f6d8 d1d8'),
  ('0001A', '3r2k1/p4ppp/1p6/8/8/1P6/P4PPP/4R1K1 w - - 0 1', 'e1e8'),
  ('0002B', 'r4rk1/pp3ppp/2p5/4N3/2BP1nb1/8/PP3PPP/R3R1K1 b - - 1 18', 'f4e2 c4e2 g4e2 e1e2 f8e8'),
  ('0003C', 'r1bqk2r/ppp2ppp/2n1pn2/8/1bBP4/2N1PN2/PP3PPP/R1BQK2R w KQkq - 3 7', 'd4d5 e6d5 c4d5 f6d5 d1d5'),
  ('0004E', 'rnbqkbnr/ppp2ppp/8/3pp3/3PP3/8/PPP2PPP/RNBQKBNR w KQkq e6 0 3', 'd4e5 d5d4 c2c3'),
  ('0005F', 'r1b1k1nr/pppp1ppp/2n2q2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 4 5', 'c3d5 f6d8 c2c3')
);

-- Verified starter puzzles (test/rules.test.ts replays each one). Format: fen
-- is the position the solver faces, moves[0] is the solver's move, then
-- replies and solver moves alternate.
INSERT INTO puzzles (id, fen, moves, rating, themes) VALUES
  ('seed01', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', 'd1d8', 600, ARRAY['mate','mateIn1','backRankMate','endgame','oneMove']),
  ('seed02', '3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1', 'd8d1', 650, ARRAY['mate','mateIn1','backRankMate','endgame','oneMove']),
  ('seed03', '3r2k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1', 'd2d8', 700, ARRAY['mate','mateIn1','backRankMate','endgame','oneMove']),
  ('seed04', 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'h5f7', 750, ARRAY['mate','mateIn1','opening','oneMove']),
  ('seed05', '6rk/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1', 'g5f7', 900, ARRAY['mate','mateIn1','smotheredMate','endgame','oneMove']),
  ('seed06', '5r1k/6pp/7N/8/8/1Q6/6PP/6K1 w - - 0 1', 'b3g8 f8g8 h6f7', 1300, ARRAY['mate','mateIn2','smotheredMate','sacrifice','short'])
ON CONFLICT (id) DO NOTHING;
