import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Drawer, Field } from "./components";
import type { Data } from "./model";

export function QuoteStarter({
  data,
  entity,
  close,
  start,
  newLead,
}: {
  data: Data;
  entity: string;
  close: () => void;
  start: (dealId: string) => void;
  newLead: () => void;
}) {
  const [search, setSearch] = useState("");
  const [company, setCompany] = useState("");
  const [deal, setDeal] = useState("");
  const companies = data.companies
    .filter(
      (c) =>
        c.id === company ||
        c.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const projects = data.deals.filter(
    (d) =>
      d.company_id === company &&
      (entity === "all" || d.entity_id === entity) &&
      !["Won", "Lost"].includes(d.stage),
  );
  return (
    <Drawer title="New quote" dirty={false} close={close}>
      <div className="quote-starter">
        <p>
          Choose the customer and project. The quote will keep its legal entity,
          contact and history together.
        </p>
        <Field label="Find customer">
          <input
            className="quote-customer-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search companies…"
            autoFocus
          />
        </Field>
        <Field label="Customer">
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setDeal("");
            }}
          >
            <option value="">Select a customer</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        {company ? (
          projects.length ? (
            <Field
              label="Project / deal"
              hint="Choose the project this quote belongs to. Its issuing entity is shown alongside it."
            >
              <select value={deal} onChange={(e) => setDeal(e.target.value)}>
                <option value="">Select a project</option>
                {projects.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ·{" "}
                    {data.entities.find((e) => e.id === d.entity_id)?.code}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="quote-starter-empty">
              <strong>No open project for this customer</strong>
              <p>
                Start a lead for this project, then qualify it to create a deal.
                You can return here to prepare its quote.
              </p>
              <button type="button" onClick={newLead}>
                Start a lead <ArrowRight size={15} />
              </button>
            </div>
          )
        ) : null}
      </div>
      <div className="quote-starter-footer">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!deal}
          onClick={() => start(deal)}
        >
          Continue to quote <ArrowRight size={16} />
        </button>
      </div>
    </Drawer>
  );
}
