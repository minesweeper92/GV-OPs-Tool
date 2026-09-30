CREATE TABLE accounting_periods (
 tenant_id uuid NOT NULL, entity_id uuid NOT NULL, month date NOT NULL,
 status text NOT NULL CHECK(status IN ('Open','Soft closed','Closed')),
 version integer NOT NULL CHECK(version>0), note text NOT NULL,
 changed_by uuid NOT NULL REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,entity_id,month),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),
 CHECK(month=date_trunc('month',month)::date)
);
CREATE TABLE accounting_period_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, month date NOT NULL,
 from_status text NOT NULL, to_status text NOT NULL, reason text NOT NULL,
 warnings jsonb NOT NULL, request_key uuid NOT NULL, payload_hash text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), actor_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id,month) REFERENCES accounting_periods(tenant_id,entity_id,month)
);
CREATE TABLE legacy_period_unlocks (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL,
 lock_date date NOT NULL, reason text NOT NULL, request_key uuid NOT NULL,
 payload_hash text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 actor_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE FUNCTION accounting_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accounting period history cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.tenant_id,NEW.entity_id,NEW.month) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.entity_id,OLD.month)
   OR NEW.version<>OLD.version+1
   OR NOT ((OLD.status='Open' AND NEW.status='Soft closed')
        OR (OLD.status='Soft closed' AND NEW.status IN ('Closed','Open'))
        OR (OLD.status='Closed' AND NEW.status='Open'))
   THEN RAISE EXCEPTION 'Invalid accounting period transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER accounting_period_history BEFORE UPDATE OR DELETE ON accounting_periods
 FOR EACH ROW EXECUTE FUNCTION accounting_period_guard();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON accounting_period_events
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON legacy_period_unlocks
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['accounting_periods','accounting_period_events','legacy_period_unlocks'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
  IF t='legacy_period_unlocks' THEN
   EXECUTE format('CREATE INDEX ON %I (tenant_id,entity_id,lock_date)',t);
  ELSE
   EXECUTE format('CREATE INDEX ON %I (tenant_id,entity_id,month)',t);
  END IF;
 END LOOP;
END $$;
GRANT UPDATE ON accounting_periods TO gv_workspace_runtime;

-- The entity row is shared-locked for posting and exclusively locked when a
-- period changes. A journal cannot race a close and slip into the closed month.
CREATE OR REPLACE FUNCTION lock_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legacy_lock date; period_state text; actor_role text;
BEGIN
 SELECT lock_date INTO legacy_lock FROM entities
  WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id FOR SHARE;
 IF legacy_lock IS NULL AND NOT FOUND THEN RAISE EXCEPTION 'Legal entity not found'; END IF;
 IF legacy_lock>=NEW.posted_on THEN RAISE EXCEPTION 'Posting date is in a locked accounting period'; END IF;
 SELECT status INTO period_state FROM accounting_periods
  WHERE tenant_id=NEW.tenant_id AND entity_id=NEW.entity_id
    AND month=date_trunc('month',NEW.posted_on)::date;
 IF period_state='Closed' THEN RAISE EXCEPTION 'Posting date is in a closed accounting period'; END IF;
 IF period_state='Soft closed' THEN
  SELECT role INTO actor_role FROM memberships
   WHERE tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND active;
  IF actor_role IS NULL OR actor_role NOT IN ('admin','finance')
   THEN RAISE EXCEPTION 'Only finance can post in a soft-closed period'; END IF;
 END IF;
 RETURN NEW;
END $$;
