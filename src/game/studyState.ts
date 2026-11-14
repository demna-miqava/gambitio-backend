import { Chess } from "chess.js";
import { AppError } from "../errors/AppError.js";

/**
 * The shared analysis of a study room: a move tree with comments and
 * arrows per position, and the position the group is looking at (cursor).
 * Stored as one JSON document (migration 018) and changed only through
 * applyStudyOp, under the room's row lock.
 */

export const STUDY_BRUSHES = ["green", "red", "blue", "yellow"] as const;
export type StudyBrush = (typeof STUDY_BRUSHES)[number];

/** An arrow (orig → dest) or a circled square (no dest). */
export interface StudyShape {
  orig: string;
  dest?: string | undefined;
  brush: StudyBrush;
}

export interface StudyNode {
  id: string;
  parentId: string | null;
  /** The move that led here; null for the root */
  san: string | null;
  uci: string | null;
  fen: string;
  /** Half-moves from the start of the game (as plyFromFen in the frontend) */
  ply: number;
  /** children[0] is the main continuation, later ones are variations */
  children: string[];
  comment: string;
  shapes: StudyShape[];
}

export interface StudyState {
  nodes: Record<string, StudyNode>;
  /** The node everyone is looking at */
  cursor: string;
  nextId: number;
}

export const ROOT_ID = "root";
export const MAX_STUDY_NODES = 1_000;
export const MAX_COMMENT_LENGTH = 1_000;
export const MAX_SHAPES = 40;
/** Moves a new room may start with */
export const MAX_START_MOVES = 300;
/**
 * The whole document as JSON. It is stored and sent on every connect, so
 * it is kept to a size that loads quickly (1,000 bare moves are ~250 KB;
 * comments and arrows take the rest).
 */
export const MAX_STUDY_BYTES = 400_000;

export type StudyOp =
  | { type: "move"; nodeId: string; uci: string }
  | { type: "goto"; nodeId: string }
  | { type: "comment"; nodeId: string; text: string }
  | { type: "shapes"; nodeId: string; shapes: StudyShape[] }
  | { type: "delete"; nodeId: string }
  | { type: "promote"; nodeId: string };

/** What an op changed, so only that is sent to the room. */
export type StudyChange =
  | { kind: "cursor"; cursor: string }
  | { kind: "node"; node: StudyNode }
  /** A move was added (the cursor moves onto it) */
  | { kind: "added"; node: StudyNode; cursor: string }
  /** A node and everything after it went */
  | { kind: "deleted"; nodeId: string; parentId: string; cursor: string }
  /** A node's children were reordered (a variation promoted) */
  | { kind: "children"; parentId: string; children: string[] }
  | { kind: "none" };

const invalid = (message: string) => new AppError(message, "INVALID_STUDY_ACTION", 400);

export function plyFromFen(fen: string): number {
  const [, turn = "w", , , , fullmove = "1"] = fen.split(" ");
  return (Number(fullmove) - 1) * 2 + (turn === "b" ? 1 : 0);
}

/** A new tree from a position (default: the start) and optional moves in SAN. */
export function createStudyState(options: { fen?: string | undefined; moves?: string[] | undefined } = {}): StudyState {
  let chess: Chess;
  try {
    chess = options.fen ? new Chess(options.fen) : new Chess();
  } catch {
    throw invalid("That FEN isn't a legal position");
  }
  const rootFen = chess.fen();
  const state: StudyState = {
    nodes: {
      [ROOT_ID]: {
        id: ROOT_ID,
        parentId: null,
        san: null,
        uci: null,
        fen: rootFen,
        ply: plyFromFen(rootFen),
        children: [],
        comment: "",
        shapes: [],
      },
    },
    cursor: ROOT_ID,
    nextId: 1,
  };
  const moves = options.moves ?? [];
  if (moves.length > MAX_START_MOVES) throw invalid("Too many moves");
  let parent = ROOT_ID;
  for (const [i, san] of moves.entries()) {
    let move;
    try {
      move = chess.move(san);
    } catch {
      throw invalid(`Move ${i + 1} (${san}) isn't legal there`);
    }
    parent = addChild(state, parent, move.san, move.from + move.to + (move.promotion ?? ""), chess.fen());
  }
  // Start at the beginning, where a review usually starts
  state.cursor = ROOT_ID;
  return state;
}

function addChild(state: StudyState, parentId: string, san: string, uci: string, fen: string): string {
  const parent = state.nodes[parentId]!;
  // Prefixed so an id can never be "root"
  const id = `n${(state.nextId++).toString(36)}`;
  state.nodes[id] = {
    id,
    parentId,
    san,
    uci,
    fen,
    ply: parent.ply + 1,
    children: [],
    comment: "",
    shapes: [],
  };
  parent.children.push(id);
  return id;
}

function nodeOf(state: StudyState, nodeId: string): StudyNode {
  const node = Object.hasOwn(state.nodes, nodeId) ? state.nodes[nodeId] : undefined;
  if (!node) throw invalid("That position is no longer in the study");
  return node;
}

/** Ids of a node and everything after it. */
function subtree(state: StudyState, nodeId: string): string[] {
  const ids = [nodeId];
  for (let i = 0; i < ids.length; i++) ids.push(...state.nodes[ids[i]!]!.children);
  return ids;
}

const SQUARE = /^[a-h][1-8]$/;
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Applies an op to a copy of the state. Throws INVALID_STUDY_ACTION for an
 * illegal move, an unknown node or a limit reached; the stored state is
 * then left as it was.
 */
export function applyStudyOp(current: StudyState, op: StudyOp): { state: StudyState; change: StudyChange } {
  const state: StudyState = structuredClone(current);
  switch (op.type) {
    case "goto": {
      nodeOf(state, op.nodeId);
      if (state.cursor === op.nodeId) return { state, change: { kind: "none" } };
      state.cursor = op.nodeId;
      return { state, change: { kind: "cursor", cursor: op.nodeId } };
    }
    case "move": {
      const parent = nodeOf(state, op.nodeId);
      if (!UCI.test(op.uci)) throw invalid("Illegal move");
      const existing = parent.children.find((id) => state.nodes[id]!.uci === op.uci);
      if (existing) {
        state.cursor = existing;
        return { state, change: { kind: "cursor", cursor: existing } };
      }
      if (Object.keys(state.nodes).length >= MAX_STUDY_NODES) {
        throw invalid(`A study can hold up to ${MAX_STUDY_NODES} moves. Delete a variation first.`);
      }
      const chess = new Chess(parent.fen);
      let move;
      try {
        move = chess.move({
          from: op.uci.slice(0, 2),
          to: op.uci.slice(2, 4),
          ...(op.uci[4] ? { promotion: op.uci[4] } : {}),
        });
      } catch {
        throw invalid("Illegal move");
      }
      const uci = move.from + move.to + (move.promotion ?? "");
      state.cursor = addChild(state, parent.id, move.san, uci, chess.fen());
      assertSize(state);
      return { state, change: { kind: "added", node: state.nodes[state.cursor]!, cursor: state.cursor } };
    }
    case "comment": {
      const node = nodeOf(state, op.nodeId);
      const text = op.text.trim();
      if (text.length > MAX_COMMENT_LENGTH) throw invalid("Comment is too long");
      if (node.comment === text) return { state, change: { kind: "none" } };
      node.comment = text;
      if (text.length > (current.nodes[node.id]?.comment.length ?? 0)) assertSize(state);
      return { state, change: { kind: "node", node } };
    }
    case "shapes": {
      const node = nodeOf(state, op.nodeId);
      if (op.shapes.length > MAX_SHAPES) throw invalid("Too many arrows");
      for (const shape of op.shapes) {
        if (!SQUARE.test(shape.orig) || (shape.dest !== undefined && !SQUARE.test(shape.dest))) {
          throw invalid("Invalid arrow");
        }
      }
      // Drop duplicates (same squares), keeping the last drawn
      const byKey = new Map<string, StudyShape>();
      for (const s of op.shapes) {
        const shape: StudyShape = { orig: s.orig, brush: s.brush, ...(s.dest && s.dest !== s.orig ? { dest: s.dest } : {}) };
        byKey.set(`${shape.orig}${shape.dest ?? ""}`, shape);
      }
      node.shapes = [...byKey.values()];
      if (node.shapes.length > (current.nodes[node.id]?.shapes.length ?? 0)) assertSize(state);
      return { state, change: { kind: "node", node } };
    }
    case "delete": {
      const node = nodeOf(state, op.nodeId);
      if (node.parentId === null) throw invalid("The starting position can't be deleted");
      const removed = subtree(state, node.id);
      const parent = state.nodes[node.parentId]!;
      parent.children = parent.children.filter((id) => id !== node.id);
      for (const id of removed) delete state.nodes[id];
      if (removed.includes(state.cursor)) state.cursor = parent.id;
      return { state, change: { kind: "deleted", nodeId: node.id, parentId: parent.id, cursor: state.cursor } };
    }
    case "promote": {
      const node = nodeOf(state, op.nodeId);
      if (node.parentId === null) return { state, change: { kind: "none" } };
      // The variation this node is in: walk up to where it leaves the main line
      let child = node;
      while (child.parentId !== null) {
        const parent = state.nodes[child.parentId]!;
        if (parent.children[0] !== child.id) {
          parent.children = [child.id, ...parent.children.filter((id) => id !== child.id)];
          return { state, change: { kind: "children", parentId: parent.id, children: parent.children } };
        }
        child = parent;
      }
      return { state, change: { kind: "none" } };
    }
  }
}

/** The document must stay small enough to store and send whole (see MAX_STUDY_BYTES). */
function assertSize(state: StudyState): void {
  if (JSON.stringify(state).length > MAX_STUDY_BYTES) {
    throw invalid("The study is full. Delete a variation or shorten some comments first.");
  }
}

/** Ids from the root (exclusive) to the node. */
export function pathTo(state: StudyState, nodeId: string): string[] {
  const path: string[] = [];
  let node = state.nodes[nodeId];
  while (node && node.parentId !== null) {
    path.unshift(node.id);
    node = state.nodes[node.parentId];
  }
  return path;
}

/** Moves in the study (the root isn't one). */
export function moveCount(state: StudyState): number {
  return Object.keys(state.nodes).length - 1;
}
