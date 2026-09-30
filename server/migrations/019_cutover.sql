CREATE TABLE cutover_batches (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL,
 cutover_date date NOT NULL, request_key uuid NOT NULL, payload_hash text NOT NULL,
 account_count integer NOT NULL, receivable_count integer NOT NULL, payable_count integer NOT NULL,
 posted_by uuid NOT NULL REFERENCES users(id), posted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
ALTER TABLE invoices ADD COLUMN opening_batch_id uuid;
ALTER TABLE bills ADD COLUMN opening_batch_id uuid;
ALTER TABLE invoices ADD FOREIGN KEY(tenant_id,opening_batch_id) REFERENCES cutover_batches(tenant_id,id);
ALTER TABLE bills ADD FOREIGN KEY(tenant_id,opening_batch_id) REFERENCES cutover_batches(tenant_id,id);
CREATE FUNCTION opening_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND NEW.opening_batch_id IS DISTINCT FROM OLD.opening_batch_id
 THEN RAISE EXCEPTION 'Opening document origin is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER opening_invoice_origin BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION opening_document_guard();
CREATE TRIGGER opening_bill_origin BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION opening_document_guard();
CREATE TRIGGER immutable_cutover BEFORE UPDATE OR DELETE ON cutover_batches FOR EACH ROW EXECUTE FUNCTION immutable_record();
ALTER TABLE cutover_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON cutover_batches TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON cutover_batches TO gv_workspace_runtime;
CREATE INDEX ON cutover_batches(tenant_id,entity_id);
