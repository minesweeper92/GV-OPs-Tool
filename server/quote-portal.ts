import { randomUUID as uuid } from "node:crypto";
import { hash, token } from "./access.ts";
import { inTenant, type Database, type SQL } from "./db.ts";
import { audit, Problem, type Context } from "./domain.ts";

const validToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const formatted = (value: string, currency: string) => {
  const absolute = BigInt(value);
  const whole = (absolute / 100n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${escape(currency)} ${whole}.${(absolute % 100n).toString().padStart(2, "0")}`;
};

export async function issueQuoteLink(
  tx: SQL,
  ctx: Context,
  quoteId: string,
  contactId: string,
  origin: string,
) {
  if (!["admin", "sales"].includes(ctx.role))
    throw new Problem(403, "Your role cannot share quotes.");
  const row = (
    await tx.query(
      `SELECT q.id,q.details,q.deal_id,d.stage,d.owner_id,d.accepted_quote_id,d.company_id,
      c.email,coalesce(nullif(a.work_email,''),c.email) AS recipient_email
     FROM quotes q JOIN deals d ON d.id=q.deal_id
     JOIN affiliations a ON a.company_id=d.company_id AND a.contact_id=$2 AND a.ended_on IS NULL
     JOIN contacts c ON c.id=a.contact_id WHERE q.id=$1 FOR UPDATE OF d`,
      [quoteId, contactId],
    )
  ).rows[0];
  if (!row)
    throw new Problem(
      404,
      "Choose an active contact at this customer company.",
    );
  if (ctx.role === "sales" && row.owner_id !== ctx.userId)
    throw new Problem(403, "This deal belongs to another team member.");
  if (["Won", "Lost"].includes(row.stage))
    throw new Problem(409, "A closed deal cannot receive a new quote link.");
  if (!row.recipient_email)
    throw new Problem(
      400,
      "Add an email address to this customer contact first.",
    );
  const today = (await tx.query("SELECT CURRENT_DATE::text AS today")).rows[0]
    .today;
  const validUntil = row.details?.valid_until;
  if (validUntil && validUntil < today)
    throw new Problem(
      409,
      "This quote has expired. Create a revision before sharing.",
    );
  const raw = token();
  await tx.query(
    "UPDATE quote_portal_links SET revoked_at=now() WHERE quote_id=$1 AND contact_id=$2 AND revoked_at IS NULL AND response IS NULL",
    [quoteId, contactId],
  );
  const expiresAt = validUntil
    ? new Date(
        Math.min(
          Date.now() + 30 * 86400000,
          Date.parse(`${validUntil}T23:59:59Z`),
        ),
      )
    : new Date(Date.now() + 30 * 86400000);
  await tx.query(
    `INSERT INTO quote_portal_links(id,tenant_id,quote_id,contact_id,token_hash,recipient_email,expires_at,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      uuid(),
      ctx.tenantId,
      quoteId,
      contactId,
      hash(raw),
      row.recipient_email,
      expiresAt.toISOString(),
      ctx.userId,
    ],
  );
  await audit(tx, ctx, quoteId, "quote.link-created", {
    contact_id: contactId,
    recipient_email: row.recipient_email,
    expires_at: expiresAt.toISOString(),
    delivery: "not-sent",
  });
  return {
    url: `${origin}/p/${raw}`,
    recipient: row.recipient_email as string,
    expiresAt: expiresAt.toISOString(),
  };
}

async function lookup(db: Database, raw: string) {
  if (!validToken(raw)) throw new Problem(404, "Quote link not found.");
  // Capability lookup is authentication, like a session lookup. All business reads/writes
  // that follow use the tenant-scoped non-bypass role.
  const link = (
    await db.query(
      "SELECT tenant_id,id FROM quote_portal_links WHERE token_hash=$1",
      [hash(raw)],
    )
  ).rows[0];
  if (!link) throw new Problem(404, "Quote link not found.");
  return link as { tenant_id: string; id: string };
}

async function quoteForLink(tx: SQL, linkId: string, lock = false) {
  const link = (
    await tx.query(
      `SELECT l.*,q.deal_id,q.number,q.option_name,q.revision,q.customer_name,q.issuer_name,q.issuer_address,
       q.issuer_tax_id,q.currency,q.lines,q.net_minor,q.tax_minor,q.total_minor,q.terms,q.details,
       d.name AS project_name,d.stage,d.accepted_quote_id
     FROM quote_portal_links l JOIN quotes q ON q.id=l.quote_id JOIN deals d ON d.id=q.deal_id
     JOIN affiliations a ON a.company_id=d.company_id AND a.contact_id=l.contact_id AND a.ended_on IS NULL
     JOIN contacts c ON c.id=l.contact_id AND coalesce(nullif(a.work_email,''),c.email)=l.recipient_email
     WHERE l.id=$1 ${lock ? "FOR UPDATE OF l,d" : ""}`,
      [linkId],
    )
  ).rows[0];
  if (!link) throw new Problem(404, "Quote link not found.");
  if (link.revoked_at || new Date(link.expires_at).getTime() <= Date.now())
    throw new Problem(410, "This quote link has expired or been replaced.");
  return link;
}

export async function publicQuote(db: Database, raw: string) {
  const capability = await lookup(db, raw);
  return inTenant(
    db,
    capability.tenant_id,
    async (tx) => {
      const quote = await quoteForLink(tx, capability.id);
      const today = (await tx.query("SELECT CURRENT_DATE::text AS today"))
        .rows[0].today;
      if (quote.details?.valid_until && quote.details.valid_until < today)
        throw new Problem(410, "This quote has expired.");
      return quote;
    },
    true,
  );
}

export async function respondToQuote(
  db: Database,
  raw: string,
  decision: "Accepted" | "Declined",
  name: string,
  comment: string,
) {
  const capability = await lookup(db, raw);
  return inTenant(db, capability.tenant_id, async (tx) => {
    const q = await quoteForLink(tx, capability.id, true);
    const today = (await tx.query("SELECT CURRENT_DATE::text AS today")).rows[0]
      .today;
    if (q.details?.valid_until && q.details.valid_until < today)
      throw new Problem(410, "This quote has expired.");
    if (q.response)
      throw new Problem(
        409,
        "A response has already been recorded for this link.",
      );
    if (["Won", "Lost"].includes(q.stage))
      throw new Problem(
        409,
        "This project has already been closed. Ask for a new quote.",
      );
    if (decision === "Accepted") {
      await tx.query(
        "UPDATE deals SET stage='Won',accepted_quote_id=$2,next_action=NULL,due_date=NULL WHERE id=$1",
        [q.deal_id, q.quote_id],
      );
      await tx.query(
        "UPDATE companies SET customer=true WHERE id=(SELECT company_id FROM deals WHERE id=$1)",
        [q.deal_id],
      );
    } else {
      await tx.query(
        "UPDATE deals SET stage='Negotiation',next_action='Discuss customer feedback' WHERE id=$1",
        [q.deal_id],
      );
    }
    await tx.query(
      `UPDATE quote_portal_links SET response=$2,response_name=$3,response_comment=$4,responded_at=now()
       WHERE id=$1`,
      [capability.id, decision, name, comment],
    );
    await tx.query(
      "INSERT INTO quote_events(id,tenant_id,quote_id,kind,reference,actor_id) VALUES($1,$2,$3,$4,$5,NULL)",
      [
        uuid(),
        capability.tenant_id,
        q.quote_id,
        decision,
        `${decision} via customer link by ${name} (${q.recipient_email})${comment ? ` — ${comment}` : ""}`,
      ],
    );
    return { decision, number: q.number };
  });
}

export function portalPage(q: Record<string, any>, raw: string) {
  const active = !q.response && !["Won", "Lost"].includes(q.stage);
  const lines = Array.isArray(q.lines) ? q.lines : [];
  const details = q.details || {};
  const rows = lines
    .map(
      (line: Record<string, any>) =>
        `<tr><td>${escape(line.description)}</td><td>${escape(line.quantity)}</td><td>${formatted(String(BigInt(line.subtotal || "0") + BigInt(line.taxMinor || "0")), q.currency)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(q.number || "Quote")} · ${escape(q.issuer_name)}</title><style>
    :root{font-family:system-ui,-apple-system,sans-serif;color:#242526;background:#f5f1e9}body{margin:0}main{max-width:860px;margin:32px auto;padding:32px;background:white;border:1px solid #dfd9ce;border-radius:16px;box-shadow:0 8px 32px #30282010}header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #ddd;padding-bottom:22px}h1{font-size:1.7rem;margin:4px 0}.eyebrow{font-size:.75rem;letter-spacing:.16em;color:#a74b2b;font-weight:700}.muted,small{color:#6c6a66}.parties{display:flex;justify-content:space-between;gap:24px;margin:28px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e7e3dd;padding:12px 8px}th:last-child,td:last-child{text-align:right}.totals{margin-left:auto;max-width:330px}.totals p{display:flex;justify-content:space-between}.grand{border-top:2px solid #252525;padding-top:10px;font-weight:700}section{margin-top:32px}.preserve{white-space:pre-wrap}label{display:block;margin:12px 0 5px;font-weight:600}input,textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #b8b4ac;border-radius:7px;font:inherit}textarea{min-height:84px}button{padding:12px 19px;border-radius:7px;border:1px solid #c6c0b5;background:white;font:inherit;cursor:pointer}button[value=Accepted]{background:#a74428;color:white;border-color:#a74428}.actions{display:flex;gap:10px;margin-top:18px}.status{padding:18px;background:#f5f1e9;border-radius:8px}@media(max-width:700px){main{margin:0;border-radius:0;padding:20px}.parties,header{display:block}}@media print{body{background:white}main{border:0;box-shadow:none;margin:0;padding:0}.response{display:none}}
    </style></head><body><main><header><div><span class="eyebrow">QUOTE · ${escape(q.option_name)} / VERSION ${escape(q.revision)}</span><h1>${escape(q.number || "Quote")}</h1><strong>${escape(q.issuer_name)}</strong><p class="muted preserve">${escape(q.issuer_address)}</p></div><div><strong>${formatted(q.total_minor, q.currency)}</strong><p class="muted">Valid until ${escape(details.valid_until || "as agreed")}</p></div></header>
    <div class="parties"><div><small>PREPARED FOR</small><h2>${escape(q.customer_name)}</h2><p class="preserve">${escape(details.billing_address || "")}</p><p>${escape(details.attention || "")}</p></div><div><small>PROJECT</small><h2>${escape(q.project_name)}</h2><p>${escape(details.subject || "")}</p></div></div>
    <table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table><div class="totals"><p><span>Subtotal</span><span>${formatted(q.net_minor, q.currency)}</span></p><p><span>Tax</span><span>${formatted(q.tax_minor, q.currency)}</span></p><p class="grand"><span>Total</span><span>${formatted(q.total_minor, q.currency)}</span></p></div>
    ${details.customer_notes ? `<section><h3>Notes</h3><p class="preserve">${escape(details.customer_notes)}</p></section>` : ""}${q.terms ? `<section><h3>Terms & conditions</h3><p class="preserve">${escape(q.terms)}</p></section>` : ""}
    <section class="response"><h2>Your response</h2>${active ? `<p class="muted">Only choose Accept if you approve this exact quote and version. Your name and response will be recorded for the issuer. A quote response does not take a payment.</p><form method="post" action="/p/${raw}/respond"><label for="name">Your name</label><input id="name" name="name" required maxlength="120" autocomplete="name"><label for="comment">Comment (optional)</label><textarea id="comment" name="comment" maxlength="2000"></textarea><div class="actions"><button type="submit" name="decision" value="Accepted">Accept quote</button><button type="submit" name="decision" value="Declined">Decline quote</button></div></form>` : `<p class="status">${q.response ? `Response recorded: ${escape(q.response)}.` : "This project is already closed."}</p>`}</section><p class="muted"><small>This private link is intended for ${escape(q.recipient_email)}. Anyone with the link can respond; please do not forward it. Use your browser’s Print command to save a PDF.</small></p></main></body></html>`;
}

export function responsePage(decision: string, number: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Response recorded</title><style>body{font-family:system-ui,sans-serif;background:#f5f1e9;color:#242526;padding:48px 20px}main{max-width:550px;margin:auto;background:white;padding:32px;border-radius:14px}</style></head><body><main><h1>Response recorded</h1><p>Your ${escape(decision.toLowerCase())} response to quote ${escape(number)} has been saved. The issuing team can now see it in the project timeline.</p></main></body></html>`;
}
