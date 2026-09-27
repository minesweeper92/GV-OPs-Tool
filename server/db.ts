import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
export type Row = Record<string, any>; // SQL boundary; request input is separately schema-validated.
export interface SQL {
  query<T extends Row = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}
export interface Database extends SQL {
  transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  path = ".data/workspace",
): Promise<Database> {
  if(!path.includes('://')) await mkdir(dirname(resolve(path)),{recursive:true});
  const raw = await PGlite.create(path, {
    parsers: { 1082: (value) => value, 20: (value) => value },
  });
  return {
    query: (sql, params = []) => raw.query(sql, params),
    transaction: (fn) => raw.transaction((tx) => fn(tx)),
    close: () => raw.close(),
  };
}
export async function openPostgres(
  connectionString: string,
): Promise<Database> {
  pg.types.setTypeParser(1082, (value) => value);
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (sql, params = []) => pool.query(sql, params),
    close: () => pool.end(),
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export async function migrate(db: Database) {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  const hash = createHash("sha256").update(sql).digest("hex");
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, checksum text NOT NULL)",
    );
    const prior = (
      await tx.query("SELECT checksum FROM migrations WHERE version=1")
    ).rows[0];
    if (prior && prior.checksum !== hash)
      throw new Error("Applied migration changed. Refusing to start.");
    if (!prior) {
      if (tx.exec) await tx.exec(sql);
      else await tx.query(sql);
      await tx.query("INSERT INTO migrations VALUES(1,$1)", [hash]);
    }
  });
}
// Only the authenticated gateway chooses tenantId. Context is transaction-local, never pooled/global.
export async function inTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: SQL) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL ROLE gv_workspace_runtime");
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    return fn(tx);
  });
}
