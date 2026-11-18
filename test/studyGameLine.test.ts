import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStudyOp,
  createStudyState,
  ROOT_ID,
  syncGameLine,
  type StudyState,
} from "../src/game/studyState.js";

/** Follows children[0] from the root: the main line in SAN */
const mainLine = (state: StudyState) => {
  const sans: string[] = [];
  let node = state.nodes[ROOT_ID]!;
  while (node.children[0]) {
    node = state.nodes[node.children[0]]!;
    sans.push(node.san!);
  }
  return sans;
};

describe("a study room's game line (Watch together)", () => {
  test("starts from the game's moves, at the latest one", () => {
    const { state, change } = syncGameLine(createStudyState(), ["e4", "e5", "Nf3"], false);
    assert.deepEqual(mainLine(state), ["e4", "e5", "Nf3"]);
    assert.equal(state.game!.line.length, 3);
    assert.equal(state.cursor, state.game!.line.at(-1));
    assert.equal(state.nodes[state.cursor]!.san, "Nf3");
    assert.equal(change.kind, "game");
  });

  test("is idempotent: the same moves change nothing", () => {
    const first = syncGameLine(createStudyState(), ["e4", "e5"], false).state;
    const again = syncGameLine(first, ["e4", "e5"], false);
    assert.equal(again.change.kind, "none");
    assert.equal(again.state, first);
  });

  test("extends the line, sends only what changed, and follows live", () => {
    const first = syncGameLine(createStudyState(), ["e4", "e5"], false).state;
    const { state, change } = syncGameLine(first, ["e4", "e5", "Nf3"], false);
    assert.ok(change.kind === "game");
    // The new node and its parent
    assert.deepEqual(change.nodes.map((n) => n.san).sort(), ["Nf3", "e5"]);
    assert.equal(state.nodes[state.cursor]!.san, "Nf3");
    assert.equal(change.cursor, state.cursor);
    // The earlier state is left as it was
    assert.equal(first.game!.line.length, 2);
  });

  test("someone looking elsewhere stays there", () => {
    let state = syncGameLine(createStudyState(), ["e4", "e5"], false).state;
    const e4 = state.game!.line[0]!;
    state = applyStudyOp(state, { type: "goto", nodeId: e4 }).state;
    // A variation of their own
    state = applyStudyOp(state, { type: "move", nodeId: e4, uci: "c7c5" }).state;
    const variation = state.cursor;
    state = syncGameLine(state, ["e4", "e5", "Nf3"], false).state;
    assert.equal(state.cursor, variation);
    assert.deepEqual(mainLine(state), ["e4", "e5", "Nf3"]);
  });

  test("a game move the room already had as a variation becomes the main line", () => {
    let state = syncGameLine(createStudyState(), ["e4"], false).state;
    const e4 = state.game!.line[0]!;
    // A member guesses two replies; the second is what the game plays
    state = applyStudyOp(state, { type: "move", nodeId: e4, uci: "e7e5" }).state;
    state = applyStudyOp(state, { type: "move", nodeId: e4, uci: "c7c5" }).state;
    const c5 = state.cursor;
    const { state: synced, change } = syncGameLine(state, ["e4", "c5"], false);
    assert.deepEqual(mainLine(synced), ["e4", "c5"]);
    assert.equal(synced.game!.line[1], c5);
    assert.ok(change.kind === "game");
    assert.deepEqual(change.nodes.map((n) => n.id), [e4]);
  });

  test("after a takeback the line is shorter and the taken-back move stays in the tree", () => {
    const before = syncGameLine(createStudyState(), ["e4", "e5", "Nf3"], false).state;
    const { state } = syncGameLine(before, ["e4", "e5"], false);
    assert.equal(state.game!.line.length, 2);
    assert.equal(state.nodes[state.cursor]!.san, "e5");
    // Then a different move: the main line follows the game again
    const after = syncGameLine(state, ["e4", "e5", "Bc4"], false).state;
    assert.deepEqual(mainLine(after), ["e4", "e5", "Bc4"]);
    assert.equal(Object.keys(after.nodes).length, 5);
  });

  test("the game's moves can't be deleted or pushed aside while it is played, but can after", () => {
    let state = syncGameLine(createStudyState(), ["e4", "e5"], false).state;
    const [e4, e5] = state.game!.line as [string, string];
    assert.throws(() => applyStudyOp(state, { type: "delete", nodeId: e5 }), /can't be deleted/);
    state = applyStudyOp(state, { type: "move", nodeId: e4, uci: "c7c5" }).state;
    const c5 = state.cursor;
    assert.throws(() => applyStudyOp(state, { type: "promote", nodeId: c5 }), /main line/);
    // Variations of the members' own are theirs to delete
    assert.equal(applyStudyOp(state, { type: "delete", nodeId: c5 }).change.kind, "deleted");

    const { state: over, change } = syncGameLine(state, ["e4", "e5"], true);
    assert.ok(change.kind === "game" && change.game.over);
    assert.equal(applyStudyOp(over, { type: "promote", nodeId: c5 }).change.kind, "children");
    assert.equal(applyStudyOp(over, { type: "delete", nodeId: e5 }).change.kind, "deleted");
  });

  test("once the game is over, deleted game moves stay deleted and leave the line", () => {
    const live = syncGameLine(createStudyState(), ["e4", "e5", "Nf3"], false).state;
    const over = syncGameLine(live, ["e4", "e5", "Nf3"], true).state;
    const [e4, e5] = over.game!.line as [string, string, string];
    const { state: deleted } = applyStudyOp(over, { type: "delete", nodeId: e5 });
    // The line ends before the deleted move, so it never names a missing node
    assert.deepEqual(deleted.game!.line, [e4]);
    assert.ok(deleted.game!.over);
    // A later sync (a member connecting) puts nothing back
    const again = syncGameLine(deleted, ["e4", "e5", "Nf3"], true);
    assert.equal(again.change.kind, "none");
    assert.equal(again.state, deleted);
    assert.deepEqual(mainLine(again.state), ["e4"]);
    // Nor does it undo a promoted variation
    let state = applyStudyOp(over, { type: "move", nodeId: e4, uci: "c7c5" }).state;
    state = applyStudyOp(state, { type: "promote", nodeId: state.cursor }).state;
    assert.equal(syncGameLine(state, ["e4", "e5", "Nf3"], true).change.kind, "none");
    assert.deepEqual(mainLine(state), ["e4", "c5"]);
  });

  test("deleting a variation leaves the game's line alone", () => {
    let state = syncGameLine(createStudyState(), ["e4", "e5"], false).state;
    const line = state.game!.line;
    state = applyStudyOp(state, { type: "move", nodeId: line[0]!, uci: "c7c5" }).state;
    const { state: after } = applyStudyOp(state, { type: "delete", nodeId: state.cursor });
    assert.equal(after.game, state.game);
  });

  test("refuses moves that don't follow from the room's start", () => {
    assert.throws(() => syncGameLine(createStudyState(), ["e4", "e4"], false), /don't follow/);
  });

  test("sync_game is not a tree op of its own", () => {
    const state = createStudyState();
    assert.equal(applyStudyOp(state, { type: "sync_game" }).change.kind, "none");
  });
});
