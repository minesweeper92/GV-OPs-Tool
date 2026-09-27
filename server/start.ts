import { createServer as createVite } from "vite";
import { openDatabase, migrate, bindEnvironment } from "./db.ts";
import { seed } from "./seed.ts";
import { createApp } from "./app.ts";
if (process.env.NODE_ENV === "production")
  throw new Error(
    "Production identity, deployment hardening and release validation are not configured. This build is local only.",
  );
const port = Number(process.env.PORT || 4320);
const db = await openDatabase(process.env.GV_SAMPLE_DB || ".data/workspace");
await migrate(db);
await bindEnvironment(db, "sample");
await seed(db);
const app = createApp(db, `http://127.0.0.1:${port}`);
const vite = await createVite({
  server: { middlewareMode: true, ws: { host: "127.0.0.1", port: port + 1 } },
  appType: "spa",
});
app.setNotFoundHandler((req, res) => {
  if (req.url.startsWith("/api/"))
    return res.code(404).send({ error: "Route not found." });
  res.hijack();
  vite.middlewares(req.raw, res.raw, () => {
    res.raw.statusCode = 404;
    res.raw.end("Not found");
  });
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Fresh GV Workspace sample build: http://127.0.0.1:${port}`);
async function close() {
  await app.close();
  await vite.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
