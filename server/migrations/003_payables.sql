CREATE TABLE bills (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, vendor_id uuid NOT NULL, deal_id uuid,
 vendor_name text NOT NULL, entity_name text NOT NULL, reference text NOT NULL,
 bill_date date NOT NULL, due_date date NOT NULL CHECK(due_date>=bill_date),
 currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')), fx_micros bigint NOT NULL CHECK(fx_micros>0),
 lines jsonb NOT NULL, tax_treatment text NOT NULL CHECK(tax_treatment IN ('expense','recoverable')),
 net_minor bigint NOT NULL CHECK(net_minor>0), tax_minor bigint NOT NULL CHECK(tax_minor>=0),
 total_minor bigint NOT NULL CHECK(total_minor=net_minor+tax_minor), base_minor bigint NOT NULL CHECK(base_minor>0),
 paid_minor bigint NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=total_minor),
 paid_base_minor bigint NOT NULL DEFAULT 0 CHECK(paid_base_minor>=0 AND paid_base_minor<=base_minor),
 status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Pending approval','Open','Paid','Voided')),
 version integer NOT NULL DEFAULT 1, notes text NOT NULL DEFAULT '', last_activity_on date NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), approved_at timestamptz,
 request_key uuid NOT NULL, request_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,request_key),
 CHECK(currency<>'PKR' OR fx_micros=1000000), CHECK(status<>'Paid' OR paid_minor=total_minor),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),
 FOREIGN KEY(tenant_id,vendor_id) REFERENCES companies(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE UNIQUE INDEX active_vendor_bill_reference ON bills(tenant_id,entity_id,vendor_id,lower(trim(reference))) WHERE status<>'Voided';
CREATE TABLE vendor_payments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, bill_id uuid NOT NULL,
 payment_date date NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), wht_minor bigint NOT NULL CHECK(wht_minor>=0),
 fee_minor bigint NOT NULL CHECK(fee_minor>=0), fx_micros bigint NOT NULL CHECK(fx_micros>0),
 carrying_minor bigint NOT NULL CHECK(carrying_minor>=0), reference text NOT NULL,
 request_key uuid NOT NULL, request_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id,bill_id) REFERENCES bills(tenant_id,entity_id,id)
);
CREATE TABLE vendor_payment_reversals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_id uuid NOT NULL, reversal_date date NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,payment_id),
 FOREIGN KEY(tenant_id,payment_id) REFERENCES vendor_payments(tenant_id,id)
);
CREATE FUNCTION bill_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.version<>OLD.version+1 OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.created_at,NEW.created_by,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.created_at,OLD.created_by,OLD.request_key,OLD.request_payload)
 THEN RAISE EXCEPTION 'Invalid bill version or identity change'; END IF;
 IF OLD.status<>'Draft' AND ROW(NEW.vendor_id,NEW.vendor_name,NEW.entity_name,NEW.deal_id,NEW.reference,NEW.bill_date,NEW.due_date,NEW.currency,NEW.fx_micros,NEW.lines,NEW.tax_treatment,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.base_minor,NEW.notes)
 IS DISTINCT FROM ROW(OLD.vendor_id,OLD.vendor_name,OLD.entity_name,OLD.deal_id,OLD.reference,OLD.bill_date,OLD.due_date,OLD.currency,OLD.fx_micros,OLD.lines,OLD.tax_treatment,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.base_minor,OLD.notes)
 THEN RAISE EXCEPTION 'Submitted and posted bill details are immutable'; END IF;
 IF OLD.status='Voided' OR
 (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Pending approval','Voided')) OR
 (OLD.status='Pending approval' AND NEW.status NOT IN ('Draft','Open','Voided')) OR
 (OLD.status IN ('Open','Paid') AND NEW.status NOT IN ('Open','Paid','Voided'))
 THEN RAISE EXCEPTION 'Invalid bill transition'; END IF;
 IF NEW.status='Voided' AND NEW.paid_minor<>0 THEN RAISE EXCEPTION 'Reverse bill payments first'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER bill_history BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION bill_history_guard();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON vendor_payment_reversals FOR EACH ROW EXECUTE FUNCTION immutable_record();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bills','vendor_payments','vendor_payment_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 END LOOP; END $$;
GRANT UPDATE ON bills TO gv_workspace_runtime;
INSERT INTO accounts(tenant_id,entity_id,code,name,type)
 SELECT e.tenant_id,e.id,a.code,a.name,a.type FROM entities e CROSS JOIN (VALUES
 ('1300','Input tax receivable','Asset'),('1400','Prepayments','Asset'),('1500','Equipment','Asset'),
 ('2000','Accounts payable','Liability'),('2200','Withholding tax payable','Liability'),
 ('5200','Project production costs','Expense'),('5300','Bank charges','Expense')) AS a(code,name,type)
 ON CONFLICT DO NOTHING;
