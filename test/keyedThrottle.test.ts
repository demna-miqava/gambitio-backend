import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedThrottle } from "../src/utils/keyedThrottle.js";

test("sends the first change at once and a burst's changes once at the window's end", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const trailing: [string, number[]][] = [];
  const throttle = new KeyedThrottle<string, number>(1_000, (key, noted) => void trailing.push([key, noted]));

  assert.equal(throttle.hit("a", [1]), true, "no window open: the caller sends");
  assert.equal(throttle.hit("a", [2]), false);
  assert.equal(throttle.hit("a", [2, 3]), false);
  assert.equal(throttle.hit("b"), true, "keys have windows of their own");
  t.mock.timers.tick(999);
  assert.deepEqual(trailing, []);
  t.mock.timers.tick(1);
  // What the leading send carried isn't sent again; repeats are sent once
  assert.deepEqual(trailing, [["a", [2, 3]]]);

  // The trailing send opened the next window
  assert.equal(throttle.hit("a", [4]), false);
  t.mock.timers.tick(1_000);
  assert.deepEqual(trailing, [["a", [2, 3]], ["a", [4]]]);
  // A window without changes sends nothing and closes
  t.mock.timers.tick(1_000);
  assert.equal(trailing.length, 2);
  assert.equal(throttle.hit("a"), true);
  throttle.stop();
});

test("stop drops the open windows and what they noted", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sent = 0;
  const throttle = new KeyedThrottle<number>(1_000, () => void sent++);
  throttle.hit(1);
  throttle.hit(1);
  throttle.stop();
  t.mock.timers.tick(5_000);
  assert.equal(sent, 0);
  assert.equal(throttle.hit(1), true);
  throttle.stop();
});
