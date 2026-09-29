import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { inTenant, type Database } from "./db.ts";
import { execute, snapshot, reports, Problem } from "./domain.ts";
import { commandSchema } from "../shared/commands.ts";
import { Access, hash, type Session } from "./access.ts";
import { IdentityProvider, equalSecret } from "./oidc.ts";
import { executePayable, payableSnapshot } from "./payables.ts";
import { reportFilter } from "../shared/reporting.ts";
import { financialReports, accountDetail } from "./financial-reports.ts";
import { bankAccounts, bankDetail, executeBank } from "./banking.ts";
import { projectSnapshot, executeProject } from "./projects.ts";
import { creditSnapshot, executeCredit } from "./credits.ts";
import { recurringSnapshot, executeRecurring } from "./recurring.ts";
import { crmSnapshot, executeCrm } from "./crm.ts";
import { executeProfile } from "./profiles.ts";
import { executeDocument } from "./documents.ts";
export function createApp(
  db: Database,
  origin: string,
  identity?: IdentityProvider,
) {
  const url = new URL(origin);
  if (!identity && url.hostname !== "127.0.0.1")
    throw new Error(
      "This first build uses local sample identities and must remain on loopback.",
    );
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  if (
    identity &&
    (identity.origin !== origin ||
      identity.access.db !== db ||
      identity.access.mode !== "oidc")
  )
    throw new Error("Identity gateway configuration mismatch.");
  const access = identity?.access || new Access(db, "sample");
  const sessions = new WeakMap<object, Session>();
  const secure = url.protocol === "https:",
    cookieName = secure
      ? "__Host-gv_workspace_session"
      : "gv_workspace_session";
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    maxAge: 28800,
  };
  const browserCookie = secure ? "__Host-gv_oidc_browser" : "gv_oidc_browser";
  const publicPaths = new Set([
    "/api/auth/config",
    ...(!identity ? ["/api/demo-accounts", "/api/demo-login"] : []),
  ]);
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
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/") || publicPaths.has(path)) return;
    const s = await access.read(req.cookies[cookieName]);
    if (req.method !== "GET") {
      const supplied = String(req.headers["x-csrf-token"] || "");
      if (!equalSecret(supplied, s.csrf))
        throw new Problem(403, "Your session changed. Refresh before saving.");
    }
    sessions.set(req, s);
  });
  app.get("/health", async () => ({
    status: "ok",
    mode: access.mode,
  }));
  app.get("/api/auth/config", async () => ({ mode: access.mode }));
  if (identity) {
    app.get("/auth/login", async (_req, res) => {
      const start = await identity.begin();
      res.setCookie(browserCookie, start.browser, {
        ...cookieOptions,
        maxAge: 600,
      });
      return res.redirect(start.url);
    });
    app.get("/auth/callback", async (req, res) => {
      try {
        const person = await identity.finish(
          new URL(req.url, origin),
          req.cookies[browserCookie],
        );
        const issued = await access.issue(
          person.userId,
          person.tenantId,
          req.cookies[cookieName] ? hash(req.cookies[cookieName]) : undefined,
        );
        res.setCookie(cookieName, issued.raw, cookieOptions);
        return res.redirect("/");
      } catch (error) {
        if (error instanceof Problem) return res.redirect("/?signin=failed");
        throw error;
      } finally {
        res.clearCookie(browserCookie, { path: "/", secure });
      }
    });
  } else {
    app.get(
      "/api/demo-accounts",
      async () =>
        (
          await db.query(
            `SELECT m.user_id,m.tenant_id,m.role,u.name,t.name AS organization FROM memberships m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id WHERE m.active=true ORDER BY t.name,u.name`,
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
      const { raw } = await access.issue(
        b.userId,
        b.tenantId,
        req.cookies[cookieName] ? hash(req.cookies[cookieName]) : undefined,
      );
      res.setCookie(cookieName, raw, cookieOptions);
      return { ok: true };
    });
  }
  app.post("/api/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE hash=$1", [
      sessions.get(req)!.hash,
    ]);
    res.clearCookie(cookieName, { path: "/", secure });
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const s = sessions.get(req)!;
    return {
      user: { id: s.userId, name: s.name, email: s.email, role: s.role || "" },
      organization: { id: s.tenantId || "", name: s.organization || "" },
      csrf: s.csrf,
      mode: access.mode,
      onboarding: !s.tenantId,
    };
  });
  app.get("/api/organizations", async (req) =>
    access.organizations(sessions.get(req)!),
  );
  app.post("/api/organizations", async (req) =>
    access.createOrganization(
      sessions.get(req)!,
      z
        .object({
          name: z.string().trim().min(2).max(150),
          entityName: z.string().trim().min(2).max(150),
          entityCode: z.string().regex(/^[A-Z0-9]{2,8}$/),
          requestKey: z.uuid(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.post("/api/organizations/switch", async (req, res) => {
    const { id } = z.object({ id: z.uuid() }).strict().parse(req.body);
    const issued = await access.switchOrganization(sessions.get(req)!, id);
    res.setCookie(cookieName, issued.raw, cookieOptions);
    return { ok: true };
  });
  const role = z.enum(["admin", "finance", "sales", "viewer"]);
  const idBody = z.object({ id: z.uuid() }).strict();
  app.get("/api/team", async (req) => access.team(sessions.get(req)!));
  app.post("/api/team/invite", async (req) =>
    access.invite(
      sessions.get(req)!,
      z
        .object({ email: z.email().max(254), role })
        .strict()
        .parse(req.body),
    ),
  );
  app.post("/api/team/revoke-invitation", async (req) =>
    access.revokeInvite(sessions.get(req)!, idBody.parse(req.body).id),
  );
  app.post("/api/team/accept-invitation", async (req) =>
    access.accept(sessions.get(req)!, idBody.parse(req.body).id),
  );
  app.post("/api/team/member", async (req) =>
    access.updateMember(
      sessions.get(req)!,
      z
        .object({
          userId: z.uuid(),
          role,
          active: z.boolean(),
          version: z.number().int().positive(),
        })
        .strict()
        .parse(req.body),
    ),
  );
  app.get("/api/data", async (req) => {
    const ctx = access.context(sessions.get(req)!);
    const crmMembers = (
      await db.query(
        "SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.active AND ($2::text<>'sales' OR u.id=$3) ORDER BY u.name",
        [ctx.tenantId, ctx.role, ctx.userId],
      )
    ).rows;
    return inTenant(
      db,
      ctx.tenantId,
      async (tx) => ({
        ...(await snapshot(tx, ctx)),
        ...(await payableSnapshot(tx, ctx)),
        bankAccounts: await bankAccounts(tx, ctx),
        ...(await projectSnapshot(tx, ctx)),
        ...(await creditSnapshot(tx, ctx)),
        ...(await recurringSnapshot(tx, ctx)),
        ...(await crmSnapshot(tx, ctx)),
        crmMembers,
      }),
      true,
    );
  });
  app.get("/api/reports", async (req) => {
    const q = z
      .object({ entityId: z.uuid(), from: z.iso.date(), to: z.iso.date() })
      .strict()
      .parse(req.query);
    if (q.from > q.to)
      throw new Problem(400, "Start date must precede end date.");
    const ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) =>
      reports(tx, ctx, q.entityId, q.from, q.to),
    );
  });
  app.get("/api/financial-reports", async (req) => {
    const q = reportFilter.parse(req.query),
      ctx = access.context(sessions.get(req)!);
    return inTenant(
      db,
      ctx.tenantId,
      (tx) => financialReports(tx, ctx, q),
      true,
    );
  });
  app.get("/api/banking", async (req) => {
    const q = z
        .strictObject({ bankId: z.uuid(), statementId: z.uuid().optional() })
        .parse(req.query),
      ctx = access.context(sessions.get(req)!);
    return inTenant(
      db,
      ctx.tenantId,
      (tx) => bankDetail(tx, ctx, q.bankId, q.statementId),
      true,
    );
  });
  app.get("/api/account-detail", async (req) => {
    const q = reportFilter
      .safeExtend({
        entityId: z.uuid(),
        code: z.string().regex(/^[A-Za-z0-9]{1,12}$/),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .parse(req.query);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) => accountDetail(tx, ctx, q), true);
  });
  app.post("/api/commands", async (req) => {
    const c = commandSchema.parse(req.body),
      ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) =>
      c.action.startsWith("document.")
        ? executeDocument(tx, ctx, c)
        : c.action.startsWith("profile.")
          ? executeProfile(tx, ctx, c)
          : c.action.startsWith("crm.")
            ? executeCrm(tx, ctx, c)
            : c.action.startsWith("recurring.")
              ? executeRecurring(tx, ctx, c)
              : c.action.startsWith("credit.")
                ? executeCredit(tx, ctx, c)
                : c.action.startsWith("project.") ||
                    ["invoice.cancel", "invoice.recognise"].includes(c.action)
                  ? executeProject(tx, ctx, c)
                  : c.action.startsWith("bank.")
                    ? executeBank(tx, ctx, c)
                    : c.action.startsWith("bill.") ||
                        c.action.startsWith("vendor-payment.")
                      ? executePayable(tx, ctx, c)
                      : execute(tx, ctx, c),
    );
  });
  app.setErrorHandler((error, req, res) => {
    if (error instanceof z.ZodError)
      return res.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
          .join("; "),
      });
    if (error instanceof RangeError)
      return res.code(400).send({ error: error.message });
    if (error instanceof Problem)
      return res.code(error.status).send({ error: error.message });
    const code = (error as { code?: string }).code;
    if (code === "23505")
      return res.code(409).send({
        error:
          "A matching record already exists. Reuse it or use a different name.",
      });
    if (["23503", "23514", "22P02"].includes(code || ""))
      return res.code(400).send({
        error: "Check the dates, amounts and related records, then try again.",
      });
    if ((error as { statusCode?: number }).statusCode === 429)
      return res
        .code(429)
        .send({ error: "Too many requests. Please wait a moment." });
    if ((error as { statusCode?: number }).statusCode === 413)
      return res.code(413).send({
        error:
          "This upload is too large. Use fewer statement rows or shorter descriptions.",
      });
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
