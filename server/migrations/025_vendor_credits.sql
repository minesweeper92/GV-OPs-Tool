ALTER TABLE entities ADD COLUMN next_vendor_credit bigint NOT NULL DEFAULT 1 CHECK(next_vendor_credit>0);
ALTER TABLE bills ADD COLUMN credited_minor bigint NOT NULL DEFAULT 0 CHECK(credited_minor>=0);
ALTER TABLE bills ADD COLUMN credited_base_minor bigint NOT NULL DEFAULT 0 CHECK(credited_base_minor>=0);
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='bills'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP EXECUTE format('ALTER TABLE bills DROP CONSTRAINT %I',c.conname); END LOOP; END $$;
ALTER TABLE bills ADD CHECK(status IN ('Draft','Pending approval','Open','Paid','Voided'));
ALTER TABLE bills ADD CHECK(paid_minor+credited_minor<=total_minor AND paid_base_minor+credited_base_minor<=base_minor);
ALTER TABLE bills ADD CHECK(status<>'Paid' OR paid_minor+credited_minor=total_minor);
ALTER TABLE bills ADD CHECK(status<>'Voided' OR credited_minor=0);
CREATE TABLE vendor_credits (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,bill_id uuid NOT NULL,number text NOT NULL,reference text NOT NULL,credit_date date NOT NULL,reason text NOT NULL,
 lines jsonb NOT NULL,net_minor bigint NOT NULL CHECK(net_minor>0),tax_minor bigint NOT NULL CHECK(tax_minor>=0),total_minor bigint NOT NULL CHECK(total_minor=net_minor+tax_minor),base_minor bigint NOT NULL CHECK(base_minor>0),tax_base_minor bigint NOT NULL CHECK(tax_base_minor>=0),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,entity_id,number),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,entity_id,bill_id) REFERENCES bills(tenant_id,entity_id,id)
);
CREATE TABLE vendor_credit_applications (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,bill_id uuid NOT NULL,application_date date NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),credit_base_minor bigint NOT NULL CHECK(credit_base_minor>=0),ap_base_minor bigint NOT NULL CHECK(ap_base_minor>=0),request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,credit_id) REFERENCES vendor_credits(tenant_id,id),FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE TABLE vendor_refunds (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,refund_date date NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor>0),credit_base_minor bigint NOT NULL CHECK(credit_base_minor>=0),fx_micros bigint NOT NULL CHECK(fx_micros>0),bank_account_id uuid,reference text NOT NULL,request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,credit_id) REFERENCES vendor_credits(tenant_id,id),FOREIGN KEY(tenant_id,bank_account_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE TABLE vendor_credit_reversals (id uuid PRIMARY KEY,tenant_id uuid NOT NULL,credit_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,credit_id),FOREIGN KEY(tenant_id,credit_id) REFERENCES vendor_credits(tenant_id,id));
CREATE TABLE vendor_application_reversals (id uuid PRIMARY KEY,tenant_id uuid NOT NULL,application_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,application_id),FOREIGN KEY(tenant_id,application_id) REFERENCES vendor_credit_applications(tenant_id,id));
CREATE TABLE vendor_refund_reversals (id uuid PRIMARY KEY,tenant_id uuid NOT NULL,refund_id uuid NOT NULL,reversal_date date NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES vendor_refunds(tenant_id,id));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['vendor_credits','vendor_credit_applications','vendor_refunds','vendor_credit_reversals','vendor_application_reversals','vendor_refund_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
GRANT UPDATE ON vendor_credits TO gv_workspace_runtime;
CREATE INDEX vendor_credit_bill ON vendor_credits(tenant_id,bill_id);
CREATE INDEX vendor_application_credit ON vendor_credit_applications(tenant_id,credit_id);
CREATE INDEX vendor_refund_credit ON vendor_refunds(tenant_id,credit_id);
INSERT INTO accounts(tenant_id,entity_id,code,name,type) SELECT tenant_id,id,'1350','Vendor credits receivable','Asset' FROM entities;
