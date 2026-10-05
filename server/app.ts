import Fastify from "fastify";
import { randomUUID as uuid } from "node:crypto";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { inTenant, type Database } from "./db.ts";
import { audit, execute, snapshot, reports, Problem } from "./domain.ts";
import { commandSchema } from "../shared/commands.ts";
import { Access, hash, type Session } from "./access.ts";
import { IdentityProvider, equalSecret } from "./oidc.ts";
import { executePayable, payableSnapshot } from "./payables.ts";
import { reportFilter } from "../shared/reporting.ts";
import { financialReports, accountDetail } from "./financial-reports.ts";
import { partyStatement } from "./statements.ts";
import { statementFilter } from "../shared/statements.ts";
import { bankAccounts, bankDetail, executeBank } from "./banking.ts";
import { projectSnapshot, executeProject } from "./projects.ts";
import { creditSnapshot, executeCredit } from "./credits.ts";
import { recurringSnapshot, executeRecurring } from "./recurring.ts";
import { crmSnapshot, executeCrm } from "./crm.ts";
import { executeProfile } from "./profiles.ts";
import { executeDocument } from "./documents.ts";
import {
  attachmentRequestLimit,
  decodeAttachment,
  persistAttachment,
  readAttachmentFile,
  removeAttachmentFile,
} from "./attachment-store.ts";
import { executeManualJournal } from "./manual-journals.ts";
import {
  executeJournalSchedule,
  journalScheduleSnapshot,
} from "./journal-schedules.ts";
import { executeAccount } from "./accounts.ts";
import { cutoverInput } from "../shared/cutover.ts";
import { commitCutover, cutoverHistory, previewCutover } from "./cutover.ts";
import {
  periodPreview,
  transitionPeriod,
  unlockLegacyPeriod,
} from "./periods.ts";
import {
  issueQuoteLink,
  portalPage,
  publicQuote,
  respondToQuote,
  responsePage,
} from "./quote-portal.ts";
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
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
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
  app.post("/api/quote-links", async (req) => {
    const input = z
      .strictObject({ quoteId: z.uuid(), contactId: z.uuid() })
      .parse(req.body);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) =>
      issueQuoteLink(tx, ctx, input.quoteId, input.contactId, origin),
    );
  });
  app.get<{ Params: { token: string } }>("/p/:token", async (req, res) => {
    const q = await publicQuote(db, req.params.token);
    return res
      .header("Referrer-Policy", "same-origin")
      .type("text/html; charset=utf-8")
      .send(portalPage(q, req.params.token));
  });
  app.post<{ Params: { token: string } }>(
    "/p/:token/respond",
    async (req, res) => {
      const input = z
        .strictObject({
          name: z.string().trim().min(2).max(120),
          comment: z.string().trim().max(2000).default(""),
          decision: z.enum(["Accepted", "Declined"]),
        })
        .parse(req.body);
      const result = await respondToQuote(
        db,
        req.params.token,
        input.decision,
        input.name,
        input.comment,
      );
      return res
        .type("text/html; charset=utf-8")
        .send(responsePage(result.decision, result.number));
    },
  );
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
  app.post(
    "/api/documents/:type/:id/attachments",
    { bodyLimit: attachmentRequestLimit },
    async (req) => {
      const params = z
        .strictObject({ type: z.enum(["quote", "invoice"]), id: z.uuid() })
        .parse(req.params);
      const body = z
        .strictObject({
          filename: z.string().min(1).max(500),
          contentType: z.string().max(150),
          data: z.string().max(attachmentRequestLimit),
        })
        .parse(req.body);
      const ctx = access.context(sessions.get(req)!);
      if (!["admin", "finance", "sales"].includes(ctx.role))
        throw new Problem(403, "Your role cannot add document attachments.");
      const document = await inTenant(db, ctx.tenantId, async (tx) => {
        const sql =
          params.type === "quote"
            ? "SELECT q.id,d.owner_id FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.id=$1"
            : "SELECT i.id,d.owner_id FROM invoices i LEFT JOIN deals d ON d.id=i.deal_id WHERE i.id=$1";
        return (await tx.query(sql, [params.id])).rows[0];
      });
      if (
        !document ||
        (ctx.role === "sales" && document.owner_id !== ctx.userId)
      )
        throw new Problem(404, "Document not found.");
      const file = decodeAttachment(body.filename, body.contentType, body.data);
      const id = uuid();
      await persistAttachment(id, file.bytes);
      try {
        return await inTenant(db, ctx.tenantId, async (tx) => {
          const count = (
            await tx.query(
              "SELECT count(*)::int AS count FROM document_attachments WHERE quote_id=$1 OR invoice_id=$1",
              [params.id],
            )
          ).rows[0].count;
          if (count >= 20)
            throw new Problem(409, "A document can have up to 20 attachments.");
          const result = await tx.query(
            `INSERT INTO document_attachments
             (id,tenant_id,quote_id,invoice_id,filename,content_type,size_bytes,storage_key,uploaded_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id,quote_id,invoice_id,filename,content_type,size_bytes,uploaded_by,created_at`,
            [
              id,
              ctx.tenantId,
              params.type === "quote" ? params.id : null,
              params.type === "invoice" ? params.id : null,
              file.filename,
              file.contentType,
              file.bytes.length,
              id,
              ctx.userId,
            ],
          );
          await audit(tx, ctx, params.id, "document.attachment.added", {
            attachment_id: id,
            filename: file.filename,
            content_type: file.contentType,
            size_bytes: file.bytes.length,
          });
          return result.rows[0];
        });
      } catch (error) {
        await removeAttachmentFile(id);
        throw error;
      }
    },
  );
  app.get("/api/documents/attachments/:id", async (req, res) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(req.params);
    const ctx = access.context(sessions.get(req)!);
    const attachment = await inTenant(
      db,
      ctx.tenantId,
      async (tx) =>
        (
          await tx.query(
            `SELECT a.id,a.filename,a.content_type,a.storage_key,d.owner_id
           FROM document_attachments a
           LEFT JOIN quotes q ON q.id=a.quote_id
           LEFT JOIN invoices i ON i.id=a.invoice_id
           LEFT JOIN deals d ON d.id=coalesce(q.deal_id,i.deal_id)
           WHERE a.id=$1`,
            [id],
          )
        ).rows[0],
    );
    if (
      !attachment ||
      (ctx.role === "sales" && attachment.owner_id !== ctx.userId)
    )
      throw new Problem(404, "Attachment not found.");
    let bytes: Buffer;
    try {
      bytes = await readAttachmentFile(attachment.storage_key);
    } catch {
      throw new Problem(404, "Attachment file is unavailable.");
    }
    const fallback = attachment.filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(attachment.filename).replaceAll(
      "'",
      "%27",
    );
    return res
      .header(
        "Content-Disposition",
        `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      )
      .type(attachment.content_type)
      .send(bytes);
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
        ...(await journalScheduleSnapshot(tx, ctx)),
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
  app.get("/api/period-close", async (req) => {
    const q = z
      .strictObject({
        entityId: z.uuid(),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      })
      .parse(req.query);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(
      db,
      ctx.tenantId,
      (tx) => periodPreview(tx, ctx, q.entityId, q.month),
      true,
    );
  });
  app.get("/api/cutover", async (req) => {
    const q = z.strictObject({ entityId: z.uuid() }).parse(req.query);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(
      db,
      ctx.tenantId,
      (tx) => cutoverHistory(tx, ctx, q.entityId),
      true,
    );
  });
  app.post("/api/cutover/preview", { bodyLimit: 512 * 1024 }, async (req) => {
    const input = cutoverInput.parse(req.body);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(
      db,
      ctx.tenantId,
      (tx) => previewCutover(tx, ctx, input),
      true,
    );
  });
  app.post("/api/cutover/commit", { bodyLimit: 512 * 1024 }, async (req) => {
    const body = z
      .strictObject({
        input: cutoverInput,
        preflightHash: z.string().regex(/^[a-f0-9]{64}$/),
        requestKey: z.uuid(),
        confirmation: z.string().trim().max(8),
      })
      .parse(req.body);
    const ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) =>
      commitCutover(
        tx,
        ctx,
        body.input,
        body.preflightHash,
        body.requestKey,
        body.confirmation,
      ),
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
  app.get("/api/party-statement", async (req) => {
    const q = statementFilter.parse(req.query),
      ctx = access.context(sessions.get(req)!);
    return inTenant(db, ctx.tenantId, (tx) => partyStatement(tx, ctx, q), true);
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
        : c.action === "period.transition"
          ? transitionPeriod(tx, ctx, c)
          : c.action === "period.legacy-unlock"
            ? unlockLegacyPeriod(tx, ctx, c)
            : c.action === "account.create" ||
                c.action === "account.update" ||
                c.action === "account.set-active"
              ? executeAccount(tx, ctx, c)
              : c.action === "manual-journal.create" ||
                  c.action === "manual-journal.reverse"
                ? executeManualJournal(tx, ctx, c)
                : c.action === "journal-schedule.create" ||
                    c.action === "journal-schedule.status" ||
                    c.action === "journal-schedule.run" ||
                    c.action === "journal-schedule.skip" ||
                    c.action === "journal-schedule.post" ||
                    c.action === "journal-reversal.post"
                  ? executeJournalSchedule(tx, ctx, c)
                  : c.action.startsWith("profile.")
                    ? executeProfile(tx, ctx, c)
                    : c.action.startsWith("crm.")
                      ? executeCrm(tx, ctx, c)
                      : c.action.startsWith("recurring.")
                        ? executeRecurring(tx, ctx, c)
                        : c.action.startsWith("credit.")
                          ? executeCredit(tx, ctx, c)
                          : c.action.startsWith("project.") ||
                              ["invoice.cancel", "invoice.recognise"].includes(
                                c.action,
                              )
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
