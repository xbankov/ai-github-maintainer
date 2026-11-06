import { eq } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog, settings } from "./schema.js";

const PAUSED_KEY = "paused";

export interface KillSwitchState {
  paused: boolean;
  /** Where the pause comes from; env overrides the database. */
  source: "env" | "database" | null;
  reason: string | null;
}

interface PausedValue {
  paused: boolean;
  reason?: string | null;
}

/**
 * Global kill switch. The environment variable MAINTAINER_PAUSED forces a pause
 * (it cannot be lifted at runtime); otherwise the database flag decides.
 */
export function getKillSwitch(db: Db, envPaused: boolean): KillSwitchState {
  if (envPaused) return { paused: true, source: "env", reason: "MAINTAINER_PAUSED is set" };
  const row = db.select().from(settings).where(eq(settings.key, PAUSED_KEY)).get();
  const value = row?.value as PausedValue | undefined;
  if (value?.paused) return { paused: true, source: "database", reason: value.reason ?? null };
  return { paused: false, source: null, reason: null };
}

export function setKillSwitch(db: Db, paused: boolean, actor: string, reason?: string): void {
  db.transaction((tx) => {
    const value: PausedValue = { paused, reason: reason ?? null };
    tx.insert(settings)
      .values({ key: PAUSED_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
      .run();
    tx.insert(auditLog)
      .values({
        action: paused ? "killswitch.paused" : "killswitch.resumed",
        actor,
        details: { reason },
      })
      .run();
  });
}
