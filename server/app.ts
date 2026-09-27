import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { inTenant, type Database } from "./db.ts";
import { execute, snapshot, reports, Problem, type Context } from "./domain.ts";
import { commandSchema } from "../shared/commands.ts";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
export function createApp(db: Database, origin: string) {
  const url = new URL(origin);
  if (url.hostname !== "127.0.0.1")
    throw new Error(
      "This first build uses local sample identities and must remain on loopback.",
    );
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  const sessions = new WeakMap<
    object,
    {
      ctx: Context;
      csrf: string;
      hash: string;
      name: string;
      organization: string;
    }
  >();
  app.register(cookie);
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, res) => {
    res
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (req.headers.host !== url.host)
      throw new Problem(421, "Unexpected request host.");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== origin
    )
      throw new Problem(403, "Request origin does not match.");
    if (
      !req.url.startsWith("/api/") ||
      req.url.startsWith("/api/demo-accounts") ||
      req.url.startsWith("/api/demo-login")
    )
      return;
    const value = req.cookies.gv_workspace_session;
    const s = value
      ? (
          await db.query(
            `SELECT s.*,m.role,u.name,t.name AS organization FROM sessions s
      JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
      WHERE s.hash=$1 AND s.expires_at>now()`,
            [hash(value)],
          )
        ).rows[0]
      : null;
    if (!s) throw new Problem(401, "Sign in to the sample workspace.");
    if (req.method !== "GET") {
      const supplied = String(req.headers["x-csrf-token"] || "");
      if (
        supplied.length !== s.csrf.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(s.csrf))
      )
        throw new Problem(403, "Your session changed. Refresh before saving.");
    }
    sessions.set(req, {
      ctx: { tenantId: s.tenant_id, userId: s.user_id, role: s.role },
      csrf: s.csrf,
      hash: s.hash,
      name: s.name,
      organization: s.organization,
    });
  });
  app.get("/health", async () => ({
    status: "ok",
    mode: "local-sample-build",
  }));
  app.get(
    "/api/demo-accounts",
    async () =>
      (
        await db.query(
          `SELECT m.user_id,m.tenant_id,m.role,u.name,t.name AS organization FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id ORDER BY t.name,u.name`,
        )
      ).rows,
  );
  app.post("/api/demo-login", async (req, res) => {
    const b = z
      .object({ userId: z.uuid(), tenantId: z.uuid() })
      .strict()
      .parse(req.body);
    if (
      !(
        await db.query(
          "SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2",
          [b.tenantId, b.userId],
        )
      ).rows.length
    )
      throw new Problem(403, "Unknown sample account.");
    const raw = token(),
      csrf = token();
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM sessions WHERE expires_at<now()");
      if (req.cookies.gv_workspace_session)
        await tx.query("DELETE FROM sessions WHERE hash=$1", [
          hash(req.cookies.gv_workspace_session),
        ]);
      await tx.query(
        "INSERT INTO sessions(hash,user_id,tenant_id,csrf,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",
        [hash(raw), b.userId, b.tenantId, csrf],
      );
    });
    res.setCookie("gv_workspace_session", raw, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      maxAge: 28800,
    });
    return { ok: true };
  });
  app.post("/api/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE hash=$1", [
      sessions.get(req)!.hash,
    ]);
    res.clearCookie("gv_workspace_session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const s = sessions.get(req)!;
    return {
      user: { id: s.ctx.userId, name: s.name, role: s.ctx.role },
      organization: { id: s.ctx.tenantId, name: s.organization },
      csrf: s.csrf,
      mode: "sample",
    };
  });
  app.get("/api/data", async (req) =>
    inTenant(db, sessions.get(req)!.ctx.tenantId, (tx) =>
      snapshot(tx, sessions.get(req)!.ctx),
    ),
  );
  app.get("/api/reports", async (req) => {
    const q = z
      .object({ entityId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
      .strict()
      .parse(req.query);
    if (q.from > q.to)
      throw new Problem(400, "Start date must precede end date.");
    const ctx = sessions.get(req)!.ctx;
    return inTenant(db, ctx.tenantId, (tx) =>
      reports(tx, ctx, q.entityId, q.from, q.to),
    );
  });
  app.post("/api/commands", async (req) => {
    const c = commandSchema.parse(req.body),
      ctx = sessions.get(req)!.ctx;
    return inTenant(db, ctx.tenantId, (tx) => execute(tx, ctx, c));
  });
  app.setErrorHandler((error, req, res) => {
    if (error instanceof z.ZodError)
      return res
        .code(400)
        .send({
          error: error.issues
            .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
            .join("; "),
        });
    if (error instanceof RangeError) return res.code(400).send({error:error.message});
    if (error instanceof Problem)
      return res.code(error.status).send({ error: error.message });
    const code = (error as { code?: string }).code;
    if (code === "23505")
      return res
        .code(409)
        .send({
          error:
            "A matching record already exists. Reuse it or use a different name.",
        });
    if (["23503", "23514", "22P02"].includes(code || ""))
      return res
        .code(400)
        .send({
          error:
            "Check the dates, amounts and related records, then try again.",
        });
    if ((error as { statusCode?: number }).statusCode === 429)
      return res
        .code(429)
        .send({ error: "Too many requests. Please wait a moment." });
    console.error("Request failed", {
      requestId: req.id,
      code: code || "INTERNAL",
      message: (error as Error).message,
    });
    return res
      .code(500)
      .send({ error: "The change was not saved. Refresh and try again." });
  });
  return app;
}
