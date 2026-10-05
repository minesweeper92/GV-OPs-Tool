CREATE TABLE vendor_payment_batches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,vendor_id uuid NOT NULL,currency text NOT NULL,
 payment_date date NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),wht_minor bigint NOT NULL CHECK(wht_minor>=0),fee_minor bigint NOT NULL CHECK(fee_minor>=0),fx_micros bigint NOT NULL CHECK(fx_micros>0),bank_account_id uuid,reference text NOT NULL,
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,vendor_id) REFERENCES companies(tenant_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE vendor_payment_batch_allocations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,payment_id uuid NOT NULL,bill_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),wht_minor bigint NOT NULL CHECK(wht_minor>=0),carrying_minor bigint NOT NULL CHECK(carrying_minor>=0),cash_base_minor bigint NOT NULL CHECK(cash_base_minor>=0),wht_base_minor bigint NOT NULL CHECK(wht_base_minor>=0),fee_base_minor bigint NOT NULL CHECK(fee_base_minor>=0),
 UNIQUE(tenant_id,payment_id,bill_id),FOREIGN KEY(tenant_id,payment_id) REFERENCES vendor_payment_batches(tenant_id,id),FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE TABLE vendor_payment_batch_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,payment_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,payment_id),FOREIGN KEY(tenant_id,payment_id) REFERENCES vendor_payment_batches(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['vendor_payment_batches','vendor_payment_batch_allocations','vendor_payment_batch_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
CREATE INDEX ON vendor_payment_batch_allocations(tenant_id,bill_id);
