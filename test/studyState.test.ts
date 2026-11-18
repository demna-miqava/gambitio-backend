import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStudyOp,
  createStudyState,
  MAX_COMMENT_LENGTH,
  MAX_STUDY_BYTES,
  nodeCount,
  pathTo,
  ROOT_ID,
  storedStudyDocument,
  type StudyOp,
  type StudyState,
} from "../src/game/studyState.js";

describe("study state", () => {
  test("starts from moves, at the start", () => {
    const state = createStudyState({ moves: ["e4", "e5", "Nf3"] });
    assert.equal(state.cursor, ROOT_ID);
    assert.equal(Object.keys(state.nodes).length, 4);
    const last = Object.values(state.nodes).find((n) => n.san === "Nf3")!;
    assert.equal(last.ply, 3);
    assert.equal(pathTo(state, last.id).length, 3);
  });

  test("rejects bad positions and moves", () => {
    assert.throws(() => createStudyState({ fen: "not a fen" }), /FEN/);
    assert.throws(() => createStudyState({ moves: ["e5"] }), /Move 1/);
    const state = createStudyState();
    assert.throws(() => applyStudyOp(state, { type: "move", nodeId: ROOT_ID, uci: "e2e5" }), /Illegal/);
    assert.throws(() => applyStudyOp(state, { type: "goto", nodeId: "nope" }), /no longer/);
    assert.throws(() => applyStudyOp(state, { type: "goto", nodeId: "constructor" }), /no longer/);
  });

  test("moves add variations, replays reuse nodes, and the input is left alone", () => {
    const start = createStudyState();
    const a = applyStudyOp(start, { type: "move", nodeId: ROOT_ID, uci: "e2e4" });
    assert.equal(a.change.kind, "added");
    if (a.change.kind === "added") {
      assert.equal(a.change.node.san, "e4");
      assert.equal(a.change.cursor, a.state.cursor);
    }
    assert.equal(Object.keys(start.nodes).length, 1);
    const b = applyStudyOp(a.state, { type: "move", nodeId: ROOT_ID, uci: "d2d4" });
    assert.equal(b.state.nodes[ROOT_ID]!.children.length, 2);
    const again = applyStudyOp(b.state, { type: "move", nodeId: ROOT_ID, uci: "e2e4" });
    assert.deepEqual(again.change, { kind: "cursor", cursor: b.state.nodes[ROOT_ID]!.children[0] });
  });

  test("promote, delete, comments and arrows", () => {
    let { state } = applyStudyOp(createStudyState({ moves: ["e4", "e5"] }), {
      type: "move",
      nodeId: ROOT_ID,
      uci: "d2d4",
    });
    const d4 = state.cursor;
    ({ state } = applyStudyOp(state, { type: "move", nodeId: d4, uci: "d7d5" }));
    const promoted = applyStudyOp(state, { type: "promote", nodeId: state.cursor });
    state = promoted.state;
    assert.equal(state.nodes[ROOT_ID]!.children[0], d4);
    assert.deepEqual(promoted.change, { kind: "children", parentId: ROOT_ID, children: state.nodes[ROOT_ID]!.children });

    const commented = applyStudyOp(state, { type: "comment", nodeId: d4, text: "  Queen's pawn  " });
    assert.equal(commented.change.kind, "node");
    assert.equal(commented.state.nodes[d4]!.comment, "Queen's pawn");

    const arrows = applyStudyOp(state, {
      type: "shapes",
      nodeId: d4,
      shapes: [
        { orig: "d7", dest: "d5", brush: "green" },
        { orig: "d7", dest: "d5", brush: "red" },
        { orig: "e4", brush: "blue" },
      ],
    });
    assert.deepEqual(arrows.state.nodes[d4]!.shapes, [
      { orig: "d7", dest: "d5", brush: "red" },
      { orig: "e4", brush: "blue" },
    ]);

    const deleted = applyStudyOp(state, { type: "delete", nodeId: d4 });
    assert.equal(deleted.state.cursor, ROOT_ID);
    assert.equal(Object.keys(deleted.state.nodes).length, 3);
    assert.deepEqual(deleted.change, { kind: "deleted", nodeId: d4, parentId: ROOT_ID, cursor: ROOT_ID });
    assert.throws(() => applyStudyOp(state, { type: "delete", nodeId: ROOT_ID }), /starting position/);
  });

  test("the document can't outgrow what is stored and sent whole", () => {
    // A tree already near the limit: padding on the root comment stands in for many moves
    const state: StudyState = createStudyState({ moves: ["e4", "e5"] });
    const padding = MAX_STUDY_BYTES - JSON.stringify(state).length - 200;
    state.nodes[ROOT_ID]!.comment = "x".repeat(padding);
    // Small changes still fit...
    const moved = applyStudyOp(state, { type: "move", nodeId: ROOT_ID, uci: "d2d4" });
    assert.equal(moved.change.kind, "added");
    // ...a long comment doesn't; shortening one and deleting always do
    const e4 = state.nodes[ROOT_ID]!.children[0]!;
    assert.throws(
      () => applyStudyOp(moved.state, { type: "comment", nodeId: e4, text: "y".repeat(MAX_COMMENT_LENGTH) }),
      /study is full/
    );
    assert.equal(applyStudyOp(moved.state, { type: "comment", nodeId: ROOT_ID, text: "short" }).change.kind, "node");
    assert.equal(applyStudyOp(moved.state, { type: "delete", nodeId: e4 }).change.kind, "deleted");
  });

  test("ops copy only what they change and never touch the input", () => {
    let state = createStudyState({ moves: ["e4", "e5", "Nf3", "Nc6"] });
    ({ state } = applyStudyOp(state, { type: "move", nodeId: ROOT_ID, uci: "d2d4" }));
    const d4 = state.cursor;
    const [e4] = state.nodes[ROOT_ID]!.children;
    const ops: StudyOp[] = [
      { type: "goto", nodeId: e4! },
      { type: "move", nodeId: d4, uci: "d7d5" },
      { type: "move", nodeId: ROOT_ID, uci: "e2e4" },
      { type: "comment", nodeId: d4, text: "Queen's pawn" },
      { type: "shapes", nodeId: d4, shapes: [{ orig: "d2", dest: "d4", brush: "green" }] },
      { type: "promote", nodeId: d4 },
      { type: "delete", nodeId: e4! },
    ];
    for (const op of ops) {
      const before = structuredClone(state);
      const nodesBefore = { ...state.nodes };
      const { state: next } = applyStudyOp(state, op);
      assert.deepEqual(state, before, `${op.type} changed its input`);
      assert.notEqual(next.nodes, state.nodes);
      // Nodes the op didn't change are shared, not copied
      for (const [id, node] of Object.entries(nodesBefore)) {
        if (next.nodes[id] && JSON.stringify(next.nodes[id]) === JSON.stringify(node)) {
          assert.equal(next.nodes[id], node, `${op.type} copied ${id}`);
        }
      }
    }
  });

  test("the stored document leaves the cursor to its own column", () => {
    const { state } = applyStudyOp(createStudyState({ moves: ["e4"] }), {
      type: "move",
      nodeId: ROOT_ID,
      uci: "d2d4",
    });
    const stored = JSON.parse(storedStudyDocument(state));
    assert.equal(stored.cursor, undefined);
    assert.deepEqual({ ...stored, cursor: state.cursor }, state);
    assert.equal(nodeCount(state), 3);
  });
});
