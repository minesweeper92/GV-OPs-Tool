-- Self-contained invoice identity: project and recurring invoices retain their
-- accepted-quote provenance; direct invoices do not fabricate a CRM project.
ALTER TABLE quotes ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE invoices ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE invoices ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN company_id uuid;
ALTER TABLE invoices ADD COLUMN customer_name text;
ALTER TABLE invoices ADD COLUMN issuer_name text;
ALTER TABLE invoices ADD COLUMN issuer_address text;
ALTER TABLE invoices ADD COLUMN issuer_tax_id text;
ALTER TABLE invoices ADD COLUMN terms text;
ALTER TABLE invoices DISABLE TRIGGER invoice_history;
UPDATE invoices i SET company_id=d.company_id,customer_name=q.customer_name,
 issuer_name=q.issuer_name,issuer_address=q.issuer_address,issuer_tax_id=q.issuer_tax_id,terms=q.terms
 FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE i.quote_id=q.id;
ALTER TABLE invoices ENABLE TRIGGER invoice_history;
ALTER TABLE invoices ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN customer_name SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN issuer_name SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN issuer_address SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN issuer_tax_id SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN terms SET NOT NULL;
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id);
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id);
ALTER TABLE invoices ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE invoices ALTER COLUMN quote_id DROP NOT NULL;
ALTER TABLE invoices ADD CHECK((deal_id IS NULL)=(quote_id IS NULL));
CREATE FUNCTION invoice_identity_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record; BEGIN
 IF NEW.quote_id IS NOT NULL THEN
  SELECT quotes.*,d.company_id AS customer_id INTO STRICT q FROM quotes JOIN deals d ON d.id=quotes.deal_id
   WHERE quotes.id=NEW.quote_id AND quotes.tenant_id=NEW.tenant_id;
  NEW.company_id:=q.customer_id; NEW.customer_name:=q.customer_name;
  NEW.issuer_name:=q.issuer_name; NEW.issuer_address:=q.issuer_address; NEW.issuer_tax_id:=q.issuer_tax_id;
  NEW.terms:=q.terms;
  IF NEW.details='{}'::jsonb THEN NEW.details:=q.details; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER invoice_identity BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_identity_snapshot();
CREATE OR REPLACE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.company_id,NEW.deal_id,NEW.quote_id,NEW.created_at,NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.billing_kind,NEW.label,NEW.milestone_id,NEW.request_key,NEW.request_payload,NEW.customer_name,NEW.issuer_name,NEW.issuer_address,NEW.issuer_tax_id)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.company_id,OLD.deal_id,OLD.quote_id,OLD.created_at,OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.billing_kind,OLD.label,OLD.milestone_id,OLD.request_key,OLD.request_payload,OLD.customer_name,OLD.issuer_name,OLD.issuer_address,OLD.issuer_tax_id)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF ROW(NEW.issue_date,NEW.due_date,NEW.details,NEW.terms) IS DISTINCT FROM ROW(OLD.issue_date,OLD.due_date,OLD.details,OLD.terms)
 AND NOT (OLD.status='Draft' AND NEW.status='Draft') THEN RAISE EXCEPTION 'Issued document details are immutable'; END IF;
 IF OLD.status IN ('Paid','Voided','Cancelled') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Issued','Cancelled')) OR (OLD.status IN ('Issued','Settled') AND NEW.status NOT IN ('Issued','Paid','Settled','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF;
 NEW.version:=OLD.version+1; RETURN NEW; END $$;

CREATE TABLE catalog_items (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),name text NOT NULL,currency text NOT NULL,
 line jsonb NOT NULL,active boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES users(id),
 request_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key)
);
ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON catalog_items TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE INDEX ON catalog_items(tenant_id);
GRANT SELECT,INSERT,UPDATE ON catalog_items TO gv_workspace_runtime;
