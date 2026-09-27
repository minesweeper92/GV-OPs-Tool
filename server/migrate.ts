import { openPostgres, migrate, bindEnvironment } from "./db.ts";
// Explicit operator step, never implicit on the hosted serving path.
if (!process.env.DATABASE_URL || process.env.GV_MIGRATION_TARGET !== "oidc")
  throw new Error(
    "Set DATABASE_URL and GV_MIGRATION_TARGET=oidc for a reviewed, backed-up target.",
  );
const db = await openPostgres(process.env.DATABASE_URL);
try {
  await migrate(db);
  await bindEnvironment(db, "oidc");
  console.log("Identity-enabled database migrations verified.");
} finally {
  await db.close();
}
