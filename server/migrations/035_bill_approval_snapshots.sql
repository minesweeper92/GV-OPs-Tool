-- Retain the policy for each submission. Editing organization settings must
-- never silently weaken or replace a review already in progress.
ALTER TABLE bills ADD COLUMN approval_policy jsonb
 CHECK(approval_policy IS NULL OR jsonb_typeof(approval_policy)='object');

-- Earlier submissions did not retain their policy. Capture the rules in effect
-- at upgrade, explicitly labelled, without pretending to reconstruct history.
ALTER TABLE bills DISABLE TRIGGER bill_history;
UPDATE bills b SET approval_policy=jsonb_build_object(
 'bill_finance_limit_minor',e.bill_finance_limit_minor::text,
 'bill_separate_approver',e.bill_separate_approver,
 'bill_two_stage',e.bill_two_stage,
 'bill_approval_tiers',e.bill_approval_tiers,
 'bill_approval_version',e.bill_approval_version,
 'source','upgrade'
) FROM entities e WHERE e.id=b.entity_id AND b.status='Pending approval';
ALTER TABLE bills ENABLE TRIGGER bill_history;

CREATE FUNCTION bill_approval_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='Draft' AND NEW.status='Pending approval' THEN
   IF NEW.approval_policy IS NULL THEN RAISE EXCEPTION 'Submission requires saved approval rules'; END IF;
   IF NEW.approval_policy IS DISTINCT FROM (
     SELECT jsonb_build_object(
       'bill_finance_limit_minor',e.bill_finance_limit_minor::text,
       'bill_separate_approver',e.bill_separate_approver,
       'bill_two_stage',e.bill_two_stage,
       'bill_approval_tiers',e.bill_approval_tiers,
       'bill_approval_version',e.bill_approval_version,
       'source','submission'
     ) FROM entities e WHERE e.id=NEW.entity_id AND e.tenant_id=NEW.tenant_id
   ) THEN RAISE EXCEPTION 'Submission must retain the current entity approval rules'; END IF;
 ELSIF NEW.approval_policy IS DISTINCT FROM OLD.approval_policy THEN
   RAISE EXCEPTION 'Saved approval rules can change only on a new submission';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bill_approval_snapshot BEFORE UPDATE ON bills
 FOR EACH ROW EXECUTE FUNCTION bill_approval_snapshot_guard();
