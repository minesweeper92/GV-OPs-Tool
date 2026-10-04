-- A signed post-tax document adjustment is separate from taxable net and tax.
ALTER TABLE quotes ADD COLUMN adjustment_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN adjustment_minor bigint NOT NULL DEFAULT 0;

DO $$ DECLARE c record; BEGIN
 FOR c IN
  SELECT conrelid::regclass AS relation_name, conname
  FROM pg_constraint
  WHERE conrelid IN ('quotes'::regclass, 'invoices'::regclass)
    AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%net_minor%'
    AND pg_get_constraintdef(oid) LIKE '%tax_minor%'
    AND pg_get_constraintdef(oid) LIKE '%total_minor%'
 LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.relation_name, c.conname);
 END LOOP;
END $$;

ALTER TABLE quotes ADD CONSTRAINT quotes_total_with_adjustment
 CHECK(net_minor>=0 AND tax_minor>=0 AND total_minor=net_minor+tax_minor+adjustment_minor AND total_minor>0);
ALTER TABLE invoices ADD CONSTRAINT invoices_total_with_adjustment
 CHECK(net_minor>=0 AND tax_minor>=0 AND total_minor=net_minor+tax_minor+adjustment_minor AND total_minor>0 AND paid_minor<=total_minor);

INSERT INTO accounts(tenant_id,entity_id,code,name,type,system)
 SELECT tenant_id,id,'4020','Sales adjustments','Income',true FROM entities
 ON CONFLICT(tenant_id,entity_id,code) DO NOTHING;

CREATE OR REPLACE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Invoice identity is immutable'; END IF;
 IF ROW(NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.adjustment_minor,NEW.total_minor)
 IS DISTINCT FROM ROW(OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.adjustment_minor,OLD.total_minor)
 THEN RAISE EXCEPTION 'Invoice amount snapshot is immutable'; END IF;
 IF ROW(NEW.billing_kind,NEW.label,NEW.milestone_id,NEW.request_key,NEW.request_payload,NEW.customer_name,NEW.issuer_name,NEW.issuer_address,NEW.issuer_tax_id)
 IS DISTINCT FROM ROW(OLD.billing_kind,OLD.label,OLD.milestone_id,OLD.request_key,OLD.request_payload,OLD.customer_name,OLD.issuer_name,OLD.issuer_address,OLD.issuer_tax_id)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF ROW(NEW.issue_date,NEW.due_date,NEW.details,NEW.terms) IS DISTINCT FROM ROW(OLD.issue_date,OLD.due_date,OLD.details,OLD.terms)
 AND NOT (OLD.status='Draft' AND NEW.status='Draft') THEN RAISE EXCEPTION 'Issued document details are immutable'; END IF;
 IF OLD.status IN ('Paid','Voided','Cancelled') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status NOT IN ('Draft','Issued','Cancelled')) OR (OLD.status IN ('Issued','Settled') AND NEW.status NOT IN ('Issued','Paid','Settled','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF;
 NEW.version:=OLD.version+1; RETURN NEW; END $$;
