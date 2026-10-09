-- Amount tiers with ordered approval steps per legal entity. NULL keeps the
-- earlier finance-limit / two-stage settings, which translate to tiers.
ALTER TABLE entities ADD COLUMN bill_approval_tiers jsonb
 CHECK(bill_approval_tiers IS NULL OR jsonb_typeof(bill_approval_tiers)='array');

-- Each submission is a new round; approvals from a returned round stay in
-- history but never count toward the next one.
ALTER TABLE bills ADD COLUMN approval_round integer NOT NULL DEFAULT 0 CHECK(approval_round>=0);
-- Pending bills are in their first round. The history trigger requires a
-- version bump on every update, so this one-off backfill bypasses it.
ALTER TABLE bills DISABLE TRIGGER bill_history;
UPDATE bills SET approval_round=1 WHERE status='Pending approval';
ALTER TABLE bills ENABLE TRIGGER bill_history;

CREATE TABLE bill_approvals (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 bill_id uuid NOT NULL,
 round integer NOT NULL CHECK(round>0),
 step integer NOT NULL CHECK(step>=0),
 approver_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 UNIQUE(bill_id,round,step),
 UNIQUE(bill_id,round,approver_id),
 FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON bill_approvals
 FOR EACH ROW EXECUTE FUNCTION immutable_record();
ALTER TABLE bill_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bill_approvals TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY entity_scope ON bill_approvals AS RESTRICTIVE TO gv_workspace_runtime
 USING (EXISTS(SELECT 1 FROM bills p WHERE p.tenant_id=bill_approvals.tenant_id AND p.id=bill_approvals.bill_id));
GRANT SELECT,INSERT ON bill_approvals TO gv_workspace_runtime;
-- Existing first reviews become step-one approvals of the current round.
INSERT INTO bill_approvals(id,tenant_id,bill_id,round,step,approver_id,created_at)
 SELECT gen_random_uuid(),tenant_id,id,1,0,reviewed_by,reviewed_at
 FROM bills WHERE status='Pending approval' AND reviewed_by IS NOT NULL;

-- Intermediate steps keep a bill pending while its version advances. A new
-- round starts only on submission.
CREATE OR REPLACE FUNCTION bill_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.version<>OLD.version+1 OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.created_at,NEW.created_by,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.created_at,OLD.created_by,OLD.request_key,OLD.request_payload)
 THEN RAISE EXCEPTION 'Invalid bill version or identity change'; END IF;
 IF OLD.status<>'Draft' AND ROW(NEW.vendor_id,NEW.vendor_name,NEW.entity_name,NEW.deal_id,NEW.reference,NEW.bill_date,NEW.due_date,NEW.currency,NEW.fx_micros,NEW.lines,NEW.tax_treatment,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.base_minor,NEW.notes)
 IS DISTINCT FROM ROW(OLD.vendor_id,OLD.vendor_name,OLD.entity_name,OLD.deal_id,OLD.reference,OLD.bill_date,OLD.due_date,OLD.currency,OLD.fx_micros,OLD.lines,OLD.tax_treatment,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.base_minor,OLD.notes)
 THEN RAISE EXCEPTION 'Submitted and posted bill details are immutable'; END IF;
 IF NEW.approval_round<>OLD.approval_round AND NOT
   (OLD.status='Draft' AND NEW.status='Pending approval' AND NEW.approval_round=OLD.approval_round+1)
 THEN RAISE EXCEPTION 'Approval rounds start only on submission'; END IF;
 IF OLD.status='Draft' AND NEW.status='Pending approval' AND NEW.approval_round<>OLD.approval_round+1
 THEN RAISE EXCEPTION 'Submission must start a new approval round'; END IF;
 IF OLD.status='Voided' OR
 (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Pending approval','Voided')) OR
 (OLD.status='Pending approval' AND NEW.status NOT IN ('Draft','Pending approval','Open','Voided')) OR
 (OLD.status IN ('Open','Paid') AND NEW.status NOT IN ('Open','Paid','Voided'))
 THEN RAISE EXCEPTION 'Invalid bill transition'; END IF;
 IF NEW.status='Voided' AND NEW.paid_minor<>0 THEN RAISE EXCEPTION 'Reverse bill payments first'; END IF;
 RETURN NEW;
END $$;
