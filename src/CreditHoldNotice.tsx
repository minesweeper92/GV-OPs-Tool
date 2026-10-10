import { type Data } from "./model";

// Shown in the quote and invoice composers so a hold is seen before the
// server refuses the sale. The server remains the authority.
export function CreditHoldNotice({
  data,
  companyId,
  entityId,
}: {
  data: Data;
  companyId: string;
  entityId?: string;
}) {
  const holds = (data.creditHolds || []).filter(
    (h) =>
      !h.released_on &&
      h.company_id === companyId &&
      (!entityId || h.entity_id === entityId),
  );
  if (!companyId || !holds.length) return null;
  return (
    <div className="credit-hold-notice" role="status">
      {holds.map((h) => (
        <p key={h.id}>
          <strong>
            Credit hold ·{" "}
            {data.entities.find((e) => e.id === h.entity_id)?.code}
          </strong>{" "}
          {h.mode === "block"
            ? "New quotes and invoices for this customer are blocked until finance releases the hold."
            : "Finance has flagged this customer. You can continue, but check before committing."}{" "}
          Reason: {h.reason}
        </p>
      ))}
    </div>
  );
}
