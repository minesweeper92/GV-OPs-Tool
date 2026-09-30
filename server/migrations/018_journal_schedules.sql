CREATE TABLE journal_schedules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL,
 name text NOT NULL, reference text NOT NULL, memo text NOT NULL,
 lines jsonb NOT NULL, start_date date NOT NULL, end_date date,
 frequency text NOT NULL CHECK(frequency IN ('weekly','monthly','quarterly','yearly')),
 timezone text NOT NULL CHECK(timezone IN ('UTC','Asia/Karachi')),
 occurrences integer CHECK(occurrences BETWEEN 1 AND 1200),
 next_index integer NOT NULL DEFAULT 0 CHECK(next_index>=0),
 reverse_next_month boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Paused','Stopped','Completed')),
 version integer NOT NULL DEFAULT 1, last_error text NOT NULL DEFAULT '',
 request_key uuid NOT NULL, payload_hash text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),
 CHECK(end_date IS NULL OR end_date>=start_date),
 CHECK(jsonb_typeof(lines)='array')
);
CREATE TABLE journal_schedule_occurrences (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL,
 schedule_id uuid NOT NULL, cycle integer NOT NULL, scheduled_date date NOT NULL,
 reference text NOT NULL, memo text NOT NULL, lines jsonb NOT NULL,
 reverse_next_month boolean NOT NULL, status text NOT NULL DEFAULT 'Pending review'
  CHECK(status IN ('Pending review','Posted','Skipped')),
 journal_id uuid, reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,schedule_id,cycle),
 FOREIGN KEY(tenant_id,entity_id,schedule_id) REFERENCES journal_schedules(tenant_id,entity_id,id),
 FOREIGN KEY(tenant_id,entity_id,journal_id) REFERENCES journals(tenant_id,entity_id,id),
 CHECK(jsonb_typeof(lines)='array'),
 CHECK((status='Posted')=(journal_id IS NOT NULL))
);
CREATE TABLE journal_reversal_tasks (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL,
 original_journal_id uuid NOT NULL, due_date date NOT NULL,
 status text NOT NULL DEFAULT 'Pending review' CHECK(status IN ('Pending review','Posted')),
 reversal_journal_id uuid, posted_on date,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,original_journal_id),
 FOREIGN KEY(tenant_id,entity_id,original_journal_id) REFERENCES journals(tenant_id,entity_id,id),
 FOREIGN KEY(tenant_id,entity_id,reversal_journal_id) REFERENCES journals(tenant_id,entity_id,id),
 CHECK((status='Posted')=(reversal_journal_id IS NOT NULL))
);
CREATE FUNCTION journal_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Journal schedule history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='journal_schedules' THEN
  IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.name,NEW.reference,NEW.memo,NEW.lines,NEW.start_date,NEW.end_date,NEW.frequency,NEW.timezone,NEW.occurrences,NEW.reverse_next_month,NEW.request_key,NEW.payload_hash,NEW.created_by,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.name,OLD.reference,OLD.memo,OLD.lines,OLD.start_date,OLD.end_date,OLD.frequency,OLD.timezone,OLD.occurrences,OLD.reverse_next_month,OLD.request_key,OLD.payload_hash,OLD.created_by,OLD.created_at)
   OR NEW.version<>OLD.version+1 OR NEW.next_index<OLD.next_index OR OLD.status IN ('Stopped','Completed')
   THEN RAISE EXCEPTION 'Invalid journal schedule update'; END IF;
 ELSIF TG_TABLE_NAME='journal_schedule_occurrences' THEN
  IF OLD.status<>'Pending review' OR NEW.status NOT IN ('Posted','Skipped')
   OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.schedule_id,NEW.cycle,NEW.scheduled_date,NEW.reference,NEW.memo,NEW.lines,NEW.reverse_next_month,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.schedule_id,OLD.cycle,OLD.scheduled_date,OLD.reference,OLD.memo,OLD.lines,OLD.reverse_next_month,OLD.created_at)
   THEN RAISE EXCEPTION 'Journal occurrence history is immutable'; END IF;
 ELSE
  IF OLD.status<>'Pending review' OR NEW.status<>'Posted'
   OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.original_journal_id,NEW.due_date,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.original_journal_id,OLD.due_date,OLD.created_at)
   THEN RAISE EXCEPTION 'Journal reversal task history is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER history BEFORE UPDATE OR DELETE ON journal_schedules FOR EACH ROW EXECUTE FUNCTION journal_schedule_guard();
CREATE TRIGGER history BEFORE UPDATE OR DELETE ON journal_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION journal_schedule_guard();
CREATE TRIGGER history BEFORE UPDATE OR DELETE ON journal_reversal_tasks FOR EACH ROW EXECUTE FUNCTION journal_schedule_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['journal_schedules','journal_schedule_occurrences','journal_reversal_tasks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO gv_workspace_runtime',t);
  EXECUTE format('CREATE INDEX ON %I (tenant_id,entity_id)',t);
 END LOOP;
END $$;
