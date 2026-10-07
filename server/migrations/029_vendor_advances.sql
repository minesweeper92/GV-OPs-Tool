CREATE TABLE vendor_advances (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,vendor_id uuid NOT NULL,deal_id uuid,
 vendor_name text NOT NULL,currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')),advance_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),wht_minor bigint NOT NULL CHECK(wht_minor>=0),fee_minor bigint NOT NULL CHECK(fee_minor>=0),
 total_minor bigint NOT NULL CHECK(total_minor=amount_minor+wht_minor),base_minor bigint NOT NULL CHECK(base_minor>0),
 fx_micros bigint NOT NULL CHECK(fx_micros>0 AND (currency<>'PKR' OR fx_micros=1000000)),bank_account_id uuid,
 purpose text NOT NULL CHECK(purpose IN ('operating','investing')),reference text NOT NULL,notes text NOT NULL DEFAULT '',
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,vendor_id) REFERENCES companies(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE vendor_advance_applications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,advance_id uuid NOT NULL,bill_id uuid NOT NULL,application_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),carrying_minor bigint NOT NULL CHECK(carrying_minor>=0),bill_carrying_minor bigint NOT NULL CHECK(bill_carrying_minor>=0),cost_adjustments jsonb NOT NULL,
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,advance_id) REFERENCES vendor_advances(tenant_id,id),FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE TABLE vendor_advance_refunds (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,advance_id uuid NOT NULL,refund_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),carrying_minor bigint NOT NULL CHECK(carrying_minor>=0),fx_micros bigint NOT NULL CHECK(fx_micros>0),fee_minor bigint NOT NULL CHECK(fee_minor>=0),bank_account_id uuid,reference text NOT NULL,
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,advance_id) REFERENCES vendor_advances(tenant_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE vendor_advance_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,advance_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,advance_id),FOREIGN KEY(tenant_id,advance_id) REFERENCES vendor_advances(tenant_id,id)
);
CREATE TABLE vendor_advance_application_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,application_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,application_id),FOREIGN KEY(tenant_id,application_id) REFERENCES vendor_advance_applications(tenant_id,id)
);
CREATE TABLE vendor_advance_refund_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,refund_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES vendor_advance_refunds(tenant_id,id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['vendor_advances','vendor_advance_applications','vendor_advance_refunds','vendor_advance_reversals','vendor_advance_application_reversals','vendor_advance_refund_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
CREATE INDEX ON vendor_advance_applications(tenant_id,bill_id);
-- PostgreSQL requires UPDATE privilege for SELECT FOR UPDATE. The immutable
-- trigger still rejects actual changes; the lock serializes competing uses.
GRANT UPDATE ON vendor_advances TO gv_workspace_runtime;
