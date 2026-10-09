-- Money in or out of a bank or cash account that no sales or purchase document
-- explains: owner drawings and capital, salaries net of tax withheld, partner
-- reimbursements, bank interest, opening corrections. Each posts once, balanced
-- against non-control accounts, and is immutable; mistakes are reversed by a
-- new transaction in the opposite direction.
CREATE TABLE bank_transactions (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,bank_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 transaction_date date NOT NULL,
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 200),
 reference text NOT NULL DEFAULT '',
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,bank_id) REFERENCES bank_accounts(tenant_id,entity_id,id)
);
CREATE INDEX bank_transactions_bank ON bank_transactions(tenant_id,bank_id,transaction_date);
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bank_transactions TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON bank_transactions TO gv_workspace_runtime;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bank_transactions FOR EACH ROW EXECUTE FUNCTION immutable_record();
-- Honour legal-entity grants when that policy layer is installed.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='gv_entity_visible') THEN
  EXECUTE 'CREATE POLICY entity_scope ON bank_transactions AS RESTRICTIVE TO gv_workspace_runtime USING (gv_entity_visible(entity_id))';
 END IF;
END $$;
