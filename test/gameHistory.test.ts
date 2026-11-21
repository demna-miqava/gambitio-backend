import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getTimeControl, TIME_CONTROL_SECONDS } from "../src/models/common.js";
import { hasHistoryFilters, historySideWhere } from "../src/repositories/gameHistory.js";

describe("game history filters (SQL)", () => {
  test("the time control ranges are getTimeControl's", () => {
    for (let seconds = 0; seconds <= 3600; seconds += 15) {
      const tc = getTimeControl(seconds);
      const [min, max] = TIME_CONTROL_SECONDS[tc];
      assert.ok(seconds >= min && (max === null || seconds < max), `${seconds} s is ${tc}`);
    }
  });

  test("every value is a parameter, never part of the SQL", () => {
    const params: unknown[] = [1];
    const since = new Date("2026-01-01T00:00:00Z");
    const where = historySideWhere("white", { opponentId: 7, rated: false, since, timeControl: "rapid" }, params)!;
    assert.deepEqual(params, [1, 600, false, 7, since]);
    assert.match(where, /"whiteId" = \$1/);
    assert.match(where, /"time" >= \$2/);
    assert.doesNotMatch(where, /"time" </);
    assert.match(where, /rated = \$3/);
    assert.match(where, /"blackId" = \$4/);
    assert.match(where, /"createdAt" >= \$5/);
  });

  test("a colour filter leaves the other side out; results are from the owner's side", () => {
    assert.equal(historySideWhere("black", { color: "white" }, [1]), null);
    assert.match(historySideWhere("black", { result: "won" }, [1])!, /result = 'black_win'/);
    assert.match(historySideWhere("white", { result: "lost" }, [1])!, /result = 'black_win'/);
    assert.match(historySideWhere("black", {}, [1])!, /"whiteId" IS DISTINCT FROM \$1/);
  });

  test("knows when nothing is filtered", () => {
    assert.equal(hasHistoryFilters({}), false);
    assert.equal(hasHistoryFilters({ result: undefined }), false);
    assert.equal(hasHistoryFilters({ rated: false }), true);
  });
});
