-- Invoices own their currency/rate, including future recurring template changes.
ALTER TABLE invoices ADD COLUMN currency text;
ALTER TABLE invoices ADD COLUMN fx_micros bigint;
ALTER TABLE invoices DISABLE TRIGGER invoice_history;
UPDATE invoices i SET currency=q.currency,fx_micros=q.fx_micros FROM quotes q WHERE q.id=i.quote_id;
ALTER TABLE invoices ENABLE TRIGGER invoice_history;
ALTER TABLE invoices ALTER COLUMN currency SET NOT NULL;
ALTER TABLE invoices ALTER COLUMN fx_micros SET NOT NULL;
ALTER TABLE invoices ADD CHECK(currency IN ('PKR','USD','AED','EUR','GBP') AND fx_micros>0 AND (currency<>'PKR' OR fx_micros=1000000));
CREATE TABLE recurring_profiles (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('invoice','expense')),quote_id uuid,deal_id uuid,
 name text NOT NULL,description text NOT NULL DEFAULT '',amount_minor bigint NOT NULL CHECK(amount_minor>0),fx_micros bigint NOT NULL CHECK(fx_micros>0),
 start_date date NOT NULL,end_date date,frequency text NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly','yearly')),timezone text NOT NULL,
 occurrences integer CHECK(occurrences BETWEEN 1 AND 1200),next_index integer NOT NULL DEFAULT 0 CHECK(next_index>=0),due_days integer NOT NULL DEFAULT 30 CHECK(due_days BETWEEN 0 AND 365),
 status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Paused','Stopped','Completed')),version integer NOT NULL DEFAULT 1,last_error text NOT NULL DEFAULT '',
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),CHECK(end_date IS NULL OR end_date>=start_date),CHECK((kind='invoice' AND quote_id IS NOT NULL AND deal_id IS NOT NULL) OR (kind='expense' AND quote_id IS NULL AND fx_micros=1000000)),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id),FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE UNIQUE INDEX one_recurring_contract ON recurring_profiles(tenant_id,deal_id) WHERE kind='invoice';
CREATE TABLE recurring_occurrences (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,profile_id uuid NOT NULL,cycle integer NOT NULL,scheduled_date date NOT NULL,amount_minor bigint NOT NULL,fx_micros bigint NOT NULL,description text NOT NULL,
 invoice_id uuid,expense_id uuid,status text NOT NULL CHECK(status IN ('Pending review','Draft created','Posted','Skipped')),reason text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,profile_id,cycle),FOREIGN KEY(tenant_id,profile_id) REFERENCES recurring_profiles(tenant_id,id),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id),FOREIGN KEY(tenant_id,expense_id) REFERENCES expenses(tenant_id,id)
);
CREATE FUNCTION recurring_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='recurring_profiles' THEN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.kind,NEW.quote_id,NEW.deal_id,NEW.start_date,NEW.frequency,NEW.timezone,NEW.request_key,NEW.request_payload,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.kind,OLD.quote_id,OLD.deal_id,OLD.start_date,OLD.frequency,OLD.timezone,OLD.request_key,OLD.request_payload,OLD.created_by,OLD.created_at) OR NEW.version<>OLD.version+1 OR NEW.next_index<OLD.next_index OR OLD.status IN ('Stopped','Completed') THEN RAISE EXCEPTION 'Invalid recurring profile update'; END IF;
 ELSE
 IF OLD.status<>'Pending review' OR NEW.status NOT IN ('Posted','Skipped') OR ROW(NEW.id,NEW.tenant_id,NEW.profile_id,NEW.cycle,NEW.scheduled_date,NEW.amount_minor,NEW.fx_micros,NEW.description,NEW.invoice_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.profile_id,OLD.cycle,OLD.scheduled_date,OLD.amount_minor,OLD.fx_micros,OLD.description,OLD.invoice_id,OLD.created_at) THEN RAISE EXCEPTION 'Recurring occurrence history is immutable'; END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER recurring_history BEFORE UPDATE ON recurring_profiles FOR EACH ROW EXECUTE FUNCTION recurring_history_guard();
CREATE TRIGGER recurring_history BEFORE UPDATE ON recurring_occurrences FOR EACH ROW EXECUTE FUNCTION recurring_history_guard();
CREATE FUNCTION invoice_fx_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ROW(NEW.currency,NEW.fx_micros) IS DISTINCT FROM ROW(OLD.currency,OLD.fx_micros) THEN RAISE EXCEPTION 'Invoice exchange rate is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER invoice_fx BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_fx_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['recurring_profiles','recurring_occurrences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO gv_workspace_runtime',t);
 END LOOP;END $$;
