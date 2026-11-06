import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Works from both src/ (tsx) and dist/ (compiled): migrations always live in src/database/migrations. */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../src/database/migrations", import.meta.url),
);

export interface OpenDatabaseOptions {
  /** File path, or ":memory:" for tests. */
  path: string;
  migrationsFolder?: string;
}

export function openDatabase({
  path,
  migrationsFolder = MIGRATIONS_FOLDER,
}: OpenDatabaseOptions): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export function closeDatabase(db: Db): void {
  if (db.$client.open) db.$client.close();
}

/** Cheap liveness probe used by /readyz. */
export function pingDatabase(db: Db): void {
  db.$client.prepare("select 1").get();
}
