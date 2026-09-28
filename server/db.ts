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
  kind: "pglite" | "postgres";
  transaction<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(
  path = ".data/workspace",
): Promise<Database> {
  if (!path.includes("://"))
    await mkdir(dirname(resolve(path)), { recursive: true });
  const raw = await PGlite.create(path, {
    parsers: { 1082: (value) => value, 20: (value) => value },
  });
  return {
    kind: "pglite",
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
    kind: "postgres",
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
async function migrations() {
  return Promise.all(
    [
      "./schema.sql",
      "./migrations/002_access.sql",
      "./migrations/003_payables.sql",
      "./migrations/004_banking.sql",
      "./migrations/005_projects.sql",
      "./migrations/006_credits.sql",
      "./migrations/007_recurring.sql",
      "./migrations/008_crm.sql",
    ].map(async (path, index) => {
      const sql = await readFile(new URL(path, import.meta.url), "utf8");
      return {
        version: index + 1,
        sql,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}
export async function verifyMigrations(db: Database) {
  const expected = await migrations();
  const present = (
    await db.query("SELECT version,checksum FROM migrations ORDER BY version")
  ).rows;
  if (
    present.length !== expected.length ||
    expected.some(
      (m, i) =>
        present[i].version !== m.version || present[i].checksum !== m.hash,
    )
  )
    throw new Error(
      "Database migrations are missing or changed. Apply reviewed migrations before startup.",
    );
}
export async function migrate(db: Database) {
  const files = await migrations();
  await db.transaction(async (tx) => {
    if (db.kind === "postgres")
      await tx.query("SELECT pg_advisory_xact_lock(73420851)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS migrations (version integer PRIMARY KEY, checksum text NOT NULL)",
    );
    for (const { version, sql, hash } of files) {
      const prior = (
        await tx.query("SELECT checksum FROM migrations WHERE version=$1", [
          version,
        ])
      ).rows[0];
      if (prior && prior.checksum !== hash)
        throw new Error("Applied migration changed. Refusing to start.");
      if (!prior) {
        if (tx.exec) await tx.exec(sql);
        else await tx.query(sql);
        await tx.query("INSERT INTO migrations VALUES($1,$2)", [version, hash]);
      }
    }
  });
}
export async function bindEnvironment(db: Database, mode: "sample" | "oidc") {
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO database_environment(singleton,mode) VALUES(true,$1) ON CONFLICT DO NOTHING",
      [mode],
    );
    if (
      (await tx.query("SELECT mode FROM database_environment")).rows[0].mode !==
      mode
    )
      throw new Error("Sample and real identity databases must stay separate.");
  });
}
// Only the authenticated gateway chooses tenantId. Context is transaction-local, never pooled/global.
export async function inTenant<T>(
  db: Database,
  tenantId: string,
  fn: (tx: SQL) => Promise<T>,
  consistentRead = false,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (consistentRead)
      await tx.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
      );
    await tx.query("SET LOCAL ROLE gv_workspace_runtime");
    await tx.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    return fn(tx);
  });
}
