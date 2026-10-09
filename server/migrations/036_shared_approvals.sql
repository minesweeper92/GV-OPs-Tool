CREATE TABLE approval_rules (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), entity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('bill','purchase-order')), version integer NOT NULL CHECK(version>0),
 separate boolean NOT NULL, steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array'),
 UNIQUE(tenant_id,entity_id,kind), FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TABLE approval_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), entity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('bill','purchase-order')), document_id uuid NOT NULL,
 rule_version integer NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
 steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array'),
 outcome text NOT NULL DEFAULT 'Pending' CHECK(outcome IN ('Pending','Approved','Returned')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE UNIQUE INDEX one_pending_approval ON approval_runs(tenant_id,document_id) WHERE outcome='Pending';
CREATE TABLE approval_votes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), run_id uuid NOT NULL,
 step integer NOT NULL CHECK(step>=0), user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, comment text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,step,user_id), FOREIGN KEY(tenant_id,run_id) REFERENCES approval_runs(tenant_id,id)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON approval_votes FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION approval_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.outcome<>'Pending' OR NEW.outcome NOT IN ('Approved','Returned') OR
 ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.kind,NEW.document_id,NEW.rule_version,NEW.created_by,NEW.steps,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.kind,OLD.document_id,OLD.rule_version,OLD.created_by,OLD.steps,OLD.created_at)
 THEN RAISE EXCEPTION 'Approval submission history is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER history BEFORE UPDATE ON approval_runs FOR EACH ROW EXECUTE FUNCTION approval_run_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['approval_rules','approval_runs','approval_votes'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP; END $$;
CREATE POLICY entity_scope ON approval_rules AS RESTRICTIVE TO gv_workspace_runtime USING(gv_entity_visible(entity_id));
CREATE POLICY entity_scope ON approval_runs AS RESTRICTIVE TO gv_workspace_runtime USING(gv_entity_visible(entity_id));
CREATE POLICY entity_scope ON approval_votes AS RESTRICTIVE TO gv_workspace_runtime USING(EXISTS(SELECT 1 FROM approval_runs r WHERE r.id=run_id AND r.tenant_id=approval_votes.tenant_id));
GRANT SELECT,INSERT,UPDATE ON approval_rules,approval_runs TO gv_workspace_runtime;
GRANT SELECT,INSERT ON approval_votes TO gv_workspace_runtime;
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CHECK(status IN ('Draft','Pending approval','Issued','Closed','Cancelled'));
