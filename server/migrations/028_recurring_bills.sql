CREATE TABLE bill_schedules (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,vendor_id uuid NOT NULL,deal_id uuid,
 name text NOT NULL,currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')),
 lines jsonb NOT NULL,total_minor bigint NOT NULL CHECK(total_minor>0),fx_micros bigint NOT NULL CHECK(fx_micros>0 AND (currency<>'PKR' OR fx_micros=1000000)),
 tax_treatment text NOT NULL CHECK(tax_treatment IN ('expense','recoverable')),due_days integer NOT NULL CHECK(due_days BETWEEN 0 AND 365),notes text NOT NULL DEFAULT '',
 start_date date NOT NULL,end_date date CHECK(end_date IS NULL OR end_date>=start_date),frequency text NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly','yearly')),timezone text NOT NULL CHECK(timezone IN ('Asia/Karachi','UTC')),
 occurrences integer CHECK(occurrences BETWEEN 1 AND 1200),next_index integer NOT NULL DEFAULT 0 CHECK(next_index>=0),
 status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Paused','Stopped','Completed')),version integer NOT NULL DEFAULT 1,last_error text NOT NULL DEFAULT '',
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,vendor_id) REFERENCES companies(tenant_id,id),FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE TABLE bill_schedule_occurrences (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,schedule_id uuid NOT NULL,cycle integer NOT NULL CHECK(cycle>=0),scheduled_date date NOT NULL,
 bill_id uuid,status text NOT NULL CHECK(status IN ('Draft created','Skipped')),reason text NOT NULL DEFAULT '',template jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,schedule_id,cycle),UNIQUE(tenant_id,bill_id),
 CHECK((status='Draft created' AND bill_id IS NOT NULL) OR (status='Skipped' AND bill_id IS NULL AND length(reason)>0)),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES bill_schedules(tenant_id,id),FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE FUNCTION bill_schedule_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.vendor_id,NEW.deal_id,NEW.currency,NEW.start_date,NEW.frequency,NEW.timezone,NEW.request_key,NEW.request_payload,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.vendor_id,OLD.deal_id,OLD.currency,OLD.start_date,OLD.frequency,OLD.timezone,OLD.request_key,OLD.request_payload,OLD.created_by,OLD.created_at)
 OR NEW.version<>OLD.version+1 OR NEW.next_index<OLD.next_index OR OLD.status IN ('Stopped','Completed')
 THEN RAISE EXCEPTION 'Invalid recurring bill schedule update'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bill_schedule_history BEFORE UPDATE ON bill_schedules FOR EACH ROW EXECUTE FUNCTION bill_schedule_history_guard();
CREATE TRIGGER immutable BEFORE DELETE ON bill_schedules FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bill_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION immutable_record();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['bill_schedules','bill_schedule_occurrences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 END LOOP; END $$;
GRANT UPDATE ON bill_schedules TO gv_workspace_runtime;
