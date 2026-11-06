import { and, eq, notInArray } from "drizzle-orm";
import type { RepositoryConfig } from "../config/schema.js";
import type { Db } from "./client.js";
import { auditLog, repositories } from "./schema.js";

export interface SyncResult {
  added: string[];
  updated: string[];
  disabled: string[];
}

/**
 * Makes the repositories table match the configuration.
 * Repositories removed from the config are disabled, never deleted, so their
 * history (tasks, decisions) is preserved.
 */
export function syncRepositories(db: Db, configured: RepositoryConfig[]): SyncResult {
  return db.transaction((tx) => {
    const result: SyncResult = { added: [], updated: [], disabled: [] };
    for (const repo of configured) {
      const existing = tx.select().from(repositories).where(eq(repositories.id, repo.id)).get();
      const values = {
        owner: repo.owner,
        name: repo.name,
        defaultBranch: repo.default_branch,
        enabled: repo.enabled,
      };
      if (!existing) {
        tx.insert(repositories)
          .values({ id: repo.id, ...values })
          .run();
        result.added.push(repo.id);
      } else if (
        existing.owner !== values.owner ||
        existing.name !== values.name ||
        existing.defaultBranch !== values.defaultBranch ||
        existing.enabled !== values.enabled
      ) {
        tx.update(repositories).set(values).where(eq(repositories.id, repo.id)).run();
        result.updated.push(repo.id);
      }
    }
    const ids = configured.map((r) => r.id);
    const stale = tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.enabled, true), notInArray(repositories.id, ids)))
      .all();
    for (const { id } of stale) {
      tx.update(repositories).set({ enabled: false }).where(eq(repositories.id, id)).run();
      result.disabled.push(id);
    }
    if (result.added.length || result.updated.length || result.disabled.length) {
      tx.insert(auditLog).values({ action: "repositories.synced", details: result }).run();
    }
    return result;
  });
}
