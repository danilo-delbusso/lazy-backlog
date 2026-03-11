/**
 * SQLite adapter using better-sqlite3.
 * Re-exports the Database class and provides minimal type aliases
 * for the subset of the API used by this project.
 */

import Database from "better-sqlite3";

type Statement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

type SqliteDatabase = InstanceType<typeof Database>;

export { Database };
export type { SqliteDatabase, Statement };
