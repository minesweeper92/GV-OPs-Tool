CREATE TABLE document_attachments (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 quote_id uuid,
 invoice_id uuid,
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
 content_type text NOT NULL CHECK(content_type IN (
   'application/pdf','image/jpeg','image/png','image/webp',
   'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'
 )),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),
 storage_key uuid NOT NULL UNIQUE,
 uploaded_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 CHECK ((quote_id IS NOT NULL)::int + (invoice_id IS NOT NULL)::int = 1),
 FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE INDEX document_attachments_quote ON document_attachments(tenant_id,quote_id,created_at);
CREATE INDEX document_attachments_invoice ON document_attachments(tenant_id,invoice_id,created_at);
ALTER TABLE document_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON document_attachments TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON document_attachments TO gv_workspace_runtime;
