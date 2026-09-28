import { fileURLToPath } from "node:url";
import staticFiles from "@fastify/static";
import { openPostgres, verifyMigrations, bindEnvironment } from "./db.ts";
import { Access } from "./access.ts";
import { IdentityProvider } from "./oidc.ts";
import { createApp } from "./app.ts";
import { startRecurringWorker } from "./recurring.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
const origin = required("GV_PUBLIC_ORIGIN");
if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
  throw new Error("GV_PUBLIC_ORIGIN must be an HTTPS origin with no path.");
const db = await openPostgres(required("DATABASE_URL"));
try {
  await verifyMigrations(db);
  await bindEnvironment(db, "oidc");
  const identity = await IdentityProvider.connect(new Access(db, "oidc"), {
    origin,
    issuer: required("OIDC_ISSUER"),
    clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"),
  });
  const app = createApp(db, origin, identity);
  app.addHook("onSend", async (_req, res, payload) => {
    res.header("Strict-Transport-Security", "max-age=31536000");
    res.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    return payload;
  });
  await app.register(staticFiles, {
    root: fileURLToPath(new URL("../dist", import.meta.url)),
    wildcard: false,
    index: "index.html",
  });
  app.setNotFoundHandler((req, res) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/auth/"))
      return res.code(404).send({ error: "Route not found." });
    return res
      .code(404)
      .send({ error: "Page not found. Return to the workspace home." });
  });
  await app.listen({
    host: process.env.GV_BIND_HOST || "127.0.0.1",
    port: Number(process.env.PORT || 4320),
  });
  let closing = false;
  const stopRecurring = startRecurringWorker(db);
  async function close() {
    if (closing) return;
    closing = true;
    await stopRecurring();
    await app.close();
    await db.close();
  }
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  console.log(
    "GV Workspace identity-enabled server listening. TLS reverse proxy required.",
  );
} catch (error) {
  await db.close();
  throw error;
}
