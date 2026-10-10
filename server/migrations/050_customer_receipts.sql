-- Customer receipts: one bank movement from one customer, in one legal entity
-- and currency, allocated across several issued invoices. Cash, income tax
-- withheld, sales tax withheld and the bank's fee stay separate. Cash not
-- allocated is an identified liability to that customer (2410), never revenue;
-- it is applied to invoices or refunded later. Every record is immutable:
-- applications, refunds and whole receipts are undone by dated reversals.
CREATE TABLE customer_receipts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,company_id uuid NOT NULL,customer_name text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')),receipt_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),wht_minor bigint NOT NULL CHECK(wht_minor>=0),sales_tax_withheld_minor bigint NOT NULL CHECK(sales_tax_withheld_minor>=0),
 fee_minor bigint NOT NULL CHECK(fee_minor>=0 AND fee_minor<=amount_minor),
 unapplied_minor bigint NOT NULL CHECK(unapplied_minor>=0 AND unapplied_minor<=amount_minor),
 fx_micros bigint NOT NULL CHECK(fx_micros>0 AND (currency<>'PKR' OR fx_micros=1000000)),
 cash_base_minor bigint NOT NULL CHECK(cash_base_minor>=0),unapplied_base_minor bigint NOT NULL CHECK(unapplied_base_minor>=0),
 bank_account_id uuid,reference text NOT NULL,notes text NOT NULL DEFAULT '',
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 CHECK(amount_minor+wht_minor+sales_tax_withheld_minor>0),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,bank_account_id) REFERENCES bank_accounts(tenant_id,entity_id,id)
);
-- What each receipt settled on each invoice, with the PKR amounts it carried,
-- so ageing, statements, cash flow and project results stay exact per invoice.
CREATE TABLE customer_receipt_allocations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,invoice_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),wht_minor bigint NOT NULL CHECK(wht_minor>=0),sales_tax_withheld_minor bigint NOT NULL CHECK(sales_tax_withheld_minor>=0),
 carrying_minor bigint NOT NULL CHECK(carrying_minor>=0),cash_base_minor bigint NOT NULL CHECK(cash_base_minor>=0),wht_base_minor bigint NOT NULL CHECK(wht_base_minor>=0),
 sales_tax_base_minor bigint NOT NULL CHECK(sales_tax_base_minor>=0),fee_base_minor bigint NOT NULL CHECK(fee_base_minor>=0),
 CHECK(amount_minor+wht_minor+sales_tax_withheld_minor>0),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id,invoice_id),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES customer_receipts(tenant_id,id),FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE customer_receipt_applications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,invoice_id uuid NOT NULL,application_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),liability_base_minor bigint NOT NULL CHECK(liability_base_minor>=0),ar_base_minor bigint NOT NULL CHECK(ar_base_minor>=0),
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES customer_receipts(tenant_id,id),FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TABLE customer_receipt_refunds (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,refund_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),liability_base_minor bigint NOT NULL CHECK(liability_base_minor>=0),fx_micros bigint NOT NULL CHECK(fx_micros>0),
 bank_account_id uuid,reference text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES customer_receipts(tenant_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE customer_receipt_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,receipt_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,receipt_id),FOREIGN KEY(tenant_id,receipt_id) REFERENCES customer_receipts(tenant_id,id)
);
CREATE TABLE customer_receipt_application_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,application_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,application_id),FOREIGN KEY(tenant_id,application_id) REFERENCES customer_receipt_applications(tenant_id,id)
);
CREATE TABLE customer_receipt_refund_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,refund_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES customer_receipt_refunds(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['customer_receipts','customer_receipt_allocations','customer_receipt_applications','customer_receipt_refunds','customer_receipt_reversals','customer_receipt_application_reversals','customer_receipt_refund_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
CREATE INDEX ON customer_receipt_allocations(tenant_id,invoice_id);
CREATE INDEX ON customer_receipt_applications(tenant_id,invoice_id);
CREATE INDEX ON customer_receipts(tenant_id,company_id,receipt_date);
-- Row locks serialize applications, refunds and reversals; the immutable
-- trigger still rejects every actual edit.
GRANT UPDATE ON customer_receipts TO gv_workspace_runtime;
-- Legal-entity grants: the receipt carries the entity; children follow it.
CREATE POLICY entity_scope ON customer_receipts AS RESTRICTIVE TO gv_workspace_runtime USING (gv_entity_visible(entity_id));
DO $$ DECLARE r record; BEGIN FOR r IN SELECT * FROM (VALUES
 ('customer_receipt_allocations','receipt_id'),('customer_receipt_applications','receipt_id'),('customer_receipt_refunds','receipt_id'),('customer_receipt_reversals','receipt_id')) AS v(t,k) LOOP
 EXECUTE format('CREATE POLICY entity_scope ON %1$I AS RESTRICTIVE TO gv_workspace_runtime USING (EXISTS(SELECT 1 FROM customer_receipts p WHERE p.tenant_id=%1$I.tenant_id AND p.id=%1$I.%2$I))',r.t,r.k);
 END LOOP; END $$;
CREATE POLICY entity_scope ON customer_receipt_application_reversals AS RESTRICTIVE TO gv_workspace_runtime USING (
 EXISTS(SELECT 1 FROM customer_receipt_applications a WHERE a.tenant_id=customer_receipt_application_reversals.tenant_id AND a.id=application_id));
CREATE POLICY entity_scope ON customer_receipt_refund_reversals AS RESTRICTIVE TO gv_workspace_runtime USING (
 EXISTS(SELECT 1 FROM customer_receipt_refunds f WHERE f.tenant_id=customer_receipt_refund_reversals.tenant_id AND f.id=refund_id));
INSERT INTO accounts(tenant_id,entity_id,code,name,type,system)
SELECT e.tenant_id,e.id,'2410','Unapplied customer receipts','Liability',true FROM entities e
WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.entity_id=e.id AND a.code='2410');
-- Reversing a receipt must be able to reopen an invoice it had fully paid.
-- Everything else about invoice history stays exactly as before.
CREATE OR REPLACE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Invoice identity is immutable'; END IF;
 IF ROW(NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.adjustment_minor,NEW.total_minor)
 IS DISTINCT FROM ROW(OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.adjustment_minor,OLD.total_minor)
 THEN RAISE EXCEPTION 'Invoice amount snapshot is immutable'; END IF;
 IF ROW(NEW.billing_kind,NEW.label,NEW.milestone_id,NEW.request_key,NEW.request_payload,NEW.customer_name,NEW.issuer_name,NEW.issuer_address,NEW.issuer_tax_id)
 IS DISTINCT FROM ROW(OLD.billing_kind,OLD.label,OLD.milestone_id,OLD.request_key,OLD.request_payload,OLD.customer_name,OLD.issuer_name,OLD.issuer_address,OLD.issuer_tax_id)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF ROW(NEW.issue_date,NEW.due_date,NEW.details,NEW.terms) IS DISTINCT FROM ROW(OLD.issue_date,OLD.due_date,OLD.details,OLD.terms)
 AND NOT (OLD.status='Draft' AND NEW.status='Draft') THEN RAISE EXCEPTION 'Issued document details are immutable'; END IF;
 IF OLD.status IN ('Voided','Cancelled') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 -- A paid invoice reopens only when a dated receipt reversal lowers what was paid.
 IF OLD.status='Paid' AND NOT (NEW.status='Issued' AND NEW.paid_minor<OLD.paid_minor) THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Issued','Cancelled')) OR (OLD.status IN ('Issued','Settled') AND NEW.status NOT IN ('Issued','Paid','Settled','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF;
 NEW.version:=OLD.version+1; RETURN NEW; END $$;
