import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(process.env.HAZEN_DATA_DIR || "/data");
let sqlite;
function connection() {
  if (!sqlite) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    sqlite = new DatabaseSync(resolve(root, "hazentime.sqlite"));
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const mismatchSchema = readFileSync(resolve("drizzle/0009_vengeful_black_tarantula.sql"), "utf8");
    sqlite.exec(mismatchSchema.replace(/CREATE (TABLE|UNIQUE INDEX|INDEX) /g, "CREATE $1 IF NOT EXISTS "));
  }
  return sqlite;
}
function statement(sql, values = []) {
  const args = values.map(value => typeof value === "boolean" ? Number(value) : value);
  return {
    bind: (...next) => statement(sql, next),
    first: async () => connection().prepare(sql).get(...args) ?? null,
    all: async () => ({ results: connection().prepare(sql).all(...args) }),
    run: async () => execute(),
    execute,
  };
  function execute() {
    const result = connection().prepare(sql).run(...args);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}
export const databaseAdapter = {
  prepare: statement,
  async batch(statements) {
    const db = connection();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = statements.map(item => item.execute());
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
};
function receiptPath(key) {
  if (!/^receipts\/[a-zA-Z0-9_.-]+$/.test(key) || /\/\.{1,2}$/.test(key)) throw new Error("Invalid receipt key");
  return resolve(root, key);
}
export const receiptAdapter = {
  async get(key) {
    try {
      return { body: await readFile(receiptPath(key)) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  },
  async put(key, data) {
    const path = receiptPath(key);
    const temporary = path + "." + randomUUID();
    await mkdir(resolve(root, "receipts"), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, Buffer.from(data), { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  },
  async delete(key) { await rm(receiptPath(key), { force: true }); },
};
