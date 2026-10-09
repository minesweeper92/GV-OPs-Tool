import { createServer as createVite } from "vite";
import { createServer as createNetServer } from "node:net";
import { openDatabase, migrate, bindEnvironment } from "./db.ts";
import { seed } from "./seed.ts";
import { createApp } from "./app.ts";
import { startRecurringWorker } from "./recurring.ts";
if (process.env.NODE_ENV === "production")
  throw new Error(
    "Production identity, deployment hardening and release validation are not configured. This build is local only.",
  );
const port = Number(process.env.PORT || 4320);
const db = await openDatabase(process.env.GV_SAMPLE_DB || ".data/workspace");
await migrate(db);
await bindEnvironment(db, "sample");
if (process.env.GV_SKIP_SEED !== "1") await seed(db);
const app = createApp(db, `http://127.0.0.1:${port}`);
// Prefer port + 1 for live reload, but fall back to any free port so another
// dev server (or a browser-test run) on a neighbouring port cannot collide.
function freePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () =>
      preferred ? void freePort(0).then(resolve) : resolve(0),
    );
    probe.listen(preferred, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
const vite = await createVite({
  server: {
    middlewareMode: true,
    ws: { host: "127.0.0.1", port: await freePort(port + 1) },
  },
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
const stopRecurring =
  process.env.GV_DISABLE_RECURRING_WORKER === "1"
    ? async () => {}
    : startRecurringWorker(db);
async function close() {
  await stopRecurring();
  await app.close();
  await vite.close();
  await db.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
