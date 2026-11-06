import { and, eq, lt, or } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog, locks } from "./schema.js";

/**
 * Named, lease-based locks stored in SQLite (survive restarts).
 * A lock is held by an owner (e.g. "task:42") until released or until its
 * lease expires; the owner may re-acquire its own lock (idempotent).
 */
export function acquireLock(
  db: Db,
  name: string,
  owner: string,
  leaseMs: number,
  now = new Date(),
): boolean {
  return db.transaction((tx) => {
    const expiresAt = new Date(now.getTime() + leaseMs);
    const existing = tx.select().from(locks).where(eq(locks.name, name)).get();
    if (!existing) {
      tx.insert(locks).values({ name, owner, acquiredAt: now, expiresAt }).run();
    } else {
      const updated = tx
        .update(locks)
        .set({ owner, acquiredAt: existing.owner === owner ? existing.acquiredAt : now, expiresAt })
        .where(and(eq(locks.name, name), or(eq(locks.owner, owner), lt(locks.expiresAt, now))))
        .run();
      if (updated.changes === 0) return false;
    }
    if (existing?.owner !== owner) {
      tx.insert(auditLog)
        .values({ action: "lock.acquired", actor: owner, details: { name } })
        .run();
    }
    return true;
  });
}

export function releaseLock(db: Db, name: string, owner: string): boolean {
  const released =
    db
      .delete(locks)
      .where(and(eq(locks.name, name), eq(locks.owner, owner)))
      .run().changes > 0;
  if (released) {
    db.insert(auditLog).values({ action: "lock.released", actor: owner, details: { name } }).run();
  }
  return released;
}

export function lockHolder(db: Db, name: string, now = new Date()): string | null {
  const row = db.select().from(locks).where(eq(locks.name, name)).get();
  return row && row.expiresAt > now ? row.owner : null;
}

export const repoLockName = (repositoryId: string) => `implementation:${repositoryId}`;
export const taskLockOwner = (taskId: number) => `task:${taskId}`;
