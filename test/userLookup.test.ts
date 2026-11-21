import { test } from "node:test";
import assert from "node:assert/strict";
import { UserLookup } from "../src/plugins/userLookup.js";

test("a lookup that read the user just before they were deleted doesn't cache them", async () => {
  let queries = 0;
  let row: { id: number; username: string; avatarUrl: null } | null = { id: 1, username: "ann", avatarUrl: null };
  let release!: () => void;
  const db = {
    query: async () => {
      queries++;
      const read = row;
      // The row is read now; the answer arrives when the test says
      await new Promise<void>((resolve) => (release = resolve));
      return { rows: read ? [read] : [], rowCount: read ? 1 : 0 };
    },
  };
  const users = new UserLookup(db as never);

  const inFlight = users.byClerkId("clerk_ann");
  // The account is deleted (and forgotten) while that read is on its way back
  row = null;
  users.forget("clerk_ann");
  release();
  assert.equal((await inFlight)?.id, 1);

  // The next lookup asks the database again, which knows the user is gone
  const next = users.byClerkId("clerk_ann");
  release();
  assert.equal(await next, null);
  assert.equal(queries, 2);
});

test("found users are cached", async () => {
  let queries = 0;
  const db = {
    query: async () => {
      queries++;
      return { rows: [{ id: 2, username: "bob", avatarUrl: null }], rowCount: 1 };
    },
  };
  const users = new UserLookup(db as never);
  await users.byClerkId("clerk_bob");
  await users.byClerkId("clerk_bob");
  assert.equal(queries, 1);
});
