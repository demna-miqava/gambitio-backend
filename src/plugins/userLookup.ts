import type { Queryable } from "../db.js";

export interface AuthenticatedUser {
  id: number;
  username: string;
  avatarUrl: string | null;
}

/** Long enough to absorb a page's burst of requests; short enough that nothing lingers. */
const TTL_MS = 60_000;
const MAX_ENTRIES = 10_000;

/**
 * Clerk id -> local user, cached in this process for every authenticated
 * request and socket. Only found users are cached (a user finishing profile
 * setup is seen at once). Usernames never change; a deleted account is
 * forgotten here at once and on other instances within TTL_MS, the same
 * window its Clerk session token stays valid anyway.
 */
export class UserLookup {
  private entries = new Map<string, { user: AuthenticatedUser; at: number }>();

  constructor(private db: Queryable) {}

  async byClerkId(clerkId: string): Promise<AuthenticatedUser | null> {
    const now = Date.now();
    const hit = this.entries.get(clerkId);
    if (hit && now - hit.at < TTL_MS) return hit.user;

    const { rows } = await this.db.query<AuthenticatedUser>(
      `SELECT id, username, "avatarUrl" FROM users WHERE "clerkId" = $1`,
      [clerkId]
    );
    const user = rows[0] ?? null;
    this.entries.delete(clerkId);
    if (user) {
      this.entries.set(clerkId, { user, at: now });
      if (this.entries.size > MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return user;
  }

  forget(clerkId: string): void {
    this.entries.delete(clerkId);
  }

  clear(): void {
    this.entries.clear();
  }
}
