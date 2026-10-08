ALTER TABLE entities ADD COLUMN bill_two_stage boolean NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN reviewed_by uuid REFERENCES users(id);
ALTER TABLE bills ADD COLUMN reviewed_at timestamptz;
ALTER TABLE bills ADD CONSTRAINT bill_review_pair CHECK((reviewed_by IS NULL)=(reviewed_at IS NULL));
CREATE FUNCTION bill_review_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.reviewed_by,NEW.reviewed_at) IS DISTINCT FROM ROW(OLD.reviewed_by,OLD.reviewed_at) THEN
   IF OLD.status='Pending approval' AND NEW.status='Pending approval' AND OLD.reviewed_by IS NULL AND NEW.reviewed_by IS NOT NULL THEN RETURN NEW; END IF;
   IF OLD.status='Pending approval' AND NEW.status='Draft' AND NEW.reviewed_by IS NULL AND NEW.reviewed_at IS NULL THEN RETURN NEW; END IF;
   RAISE EXCEPTION 'Bill review history cannot be rewritten';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bill_review_history BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION bill_review_history_guard();
CREATE OR REPLACE FUNCTION bill_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.version<>OLD.version+1 OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.created_at,NEW.created_by,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.created_at,OLD.created_by,OLD.request_key,OLD.request_payload)
 THEN RAISE EXCEPTION 'Invalid bill version or identity change'; END IF;
 IF OLD.status<>'Draft' AND ROW(NEW.vendor_id,NEW.vendor_name,NEW.entity_name,NEW.deal_id,NEW.reference,NEW.bill_date,NEW.due_date,NEW.currency,NEW.fx_micros,NEW.lines,NEW.tax_treatment,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.base_minor,NEW.notes)
 IS DISTINCT FROM ROW(OLD.vendor_id,OLD.vendor_name,OLD.entity_name,OLD.deal_id,OLD.reference,OLD.bill_date,OLD.due_date,OLD.currency,OLD.fx_micros,OLD.lines,OLD.tax_treatment,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.base_minor,OLD.notes)
 THEN RAISE EXCEPTION 'Submitted and posted bill details are immutable'; END IF;
 IF OLD.status='Voided' OR
 (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Pending approval','Voided')) OR
 (OLD.status='Pending approval' AND NEW.status NOT IN ('Draft','Open','Voided') AND NOT
   (NEW.status='Pending approval' AND OLD.reviewed_by IS NULL AND NEW.reviewed_by IS NOT NULL)) OR
 (OLD.status IN ('Open','Paid') AND NEW.status NOT IN ('Open','Paid','Voided'))
 THEN RAISE EXCEPTION 'Invalid bill transition'; END IF;
 IF NEW.status='Voided' AND NEW.paid_minor<>0 THEN RAISE EXCEPTION 'Reverse bill payments first'; END IF;
 RETURN NEW;
END $$;
