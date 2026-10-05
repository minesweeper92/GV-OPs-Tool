ALTER TABLE entities ADD COLUMN next_purchase_order bigint NOT NULL DEFAULT 1 CHECK(next_purchase_order>0);
ALTER TABLE number_series DROP CONSTRAINT number_series_kind_check;
ALTER TABLE number_series ADD CHECK(kind IN ('quote','invoice','purchase-order'));
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,entity_id uuid NOT NULL,vendor_id uuid NOT NULL,deal_id uuid,
 number text NOT NULL,vendor_name text NOT NULL,entity_name text NOT NULL,order_date date NOT NULL,delivery_date date,
 currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')),fx_micros bigint NOT NULL CHECK(fx_micros>0),
 lines jsonb NOT NULL,net_minor bigint NOT NULL,tax_minor bigint NOT NULL,total_minor bigint NOT NULL CHECK(total_minor>0 AND total_minor=net_minor+tax_minor),
 tax_treatment text NOT NULL CHECK(tax_treatment IN ('expense','recoverable')),reference text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',terms text NOT NULL DEFAULT '',delivery_address text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Issued','Closed','Cancelled')),version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),
 request_key uuid NOT NULL,request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,entity_id,id),UNIQUE(tenant_id,entity_id,number),UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id),FOREIGN KEY(tenant_id,vendor_id) REFERENCES companies(tenant_id,id),FOREIGN KEY(tenant_id,deal_id) REFERENCES deals(tenant_id,id)
);
ALTER TABLE bills ADD COLUMN purchase_order_id uuid;
ALTER TABLE bills ADD FOREIGN KEY(tenant_id,entity_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,entity_id,id);
CREATE TABLE purchase_order_bill_lines (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,purchase_order_id uuid NOT NULL,bill_id uuid NOT NULL,
 line_index integer NOT NULL CHECK(line_index>=0),quantity_millis bigint NOT NULL CHECK(quantity_millis>0),
 UNIQUE(tenant_id,bill_id,line_index),
 FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES purchase_orders(tenant_id,id),FOREIGN KEY(tenant_id,bill_id) REFERENCES bills(tenant_id,id)
);
CREATE FUNCTION purchase_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.version<>OLD.version+1 OR ROW(NEW.id,NEW.tenant_id,NEW.entity_id,NEW.number,NEW.created_by,NEW.created_at,NEW.request_key,NEW.request_payload)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.entity_id,OLD.number,OLD.created_by,OLD.created_at,OLD.request_key,OLD.request_payload) THEN RAISE EXCEPTION 'Invalid purchase order identity or version'; END IF;
 IF OLD.status<>'Draft' AND ROW(NEW.vendor_id,NEW.vendor_name,NEW.entity_name,NEW.deal_id,NEW.order_date,NEW.delivery_date,NEW.currency,NEW.fx_micros,NEW.lines,NEW.net_minor,NEW.tax_minor,NEW.total_minor,NEW.tax_treatment,NEW.reference,NEW.notes,NEW.terms,NEW.delivery_address)
 IS DISTINCT FROM ROW(OLD.vendor_id,OLD.vendor_name,OLD.entity_name,OLD.deal_id,OLD.order_date,OLD.delivery_date,OLD.currency,OLD.fx_micros,OLD.lines,OLD.net_minor,OLD.tax_minor,OLD.total_minor,OLD.tax_treatment,OLD.reference,OLD.notes,OLD.terms,OLD.delivery_address) THEN RAISE EXCEPTION 'Issued purchase order details are immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER purchase_order_history BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_order_guard();
CREATE TRIGGER no_purchase_order_delete BEFORE DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION bill_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id OR (OLD.purchase_order_id IS NOT NULL AND ROW(NEW.lines,NEW.vendor_id,NEW.deal_id,NEW.currency) IS DISTINCT FROM ROW(OLD.lines,OLD.vendor_id,OLD.deal_id,OLD.currency)) THEN RAISE EXCEPTION 'Linked purchase order allocation is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER bill_order_history BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION bill_order_guard();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_order_bill_lines'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 END LOOP; END $$;
CREATE TRIGGER immutable_order_allocation BEFORE UPDATE OR DELETE ON purchase_order_bill_lines FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE INDEX purchase_order_allocations ON purchase_order_bill_lines(tenant_id,purchase_order_id);
CREATE FUNCTION order_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE po purchase_orders%ROWTYPE; b bills%ROWTYPE; allocated bigint; ordered bigint;
BEGIN
 SELECT * INTO po FROM purchase_orders WHERE tenant_id=NEW.tenant_id AND id=NEW.purchase_order_id FOR UPDATE;
 SELECT * INTO b FROM bills WHERE tenant_id=NEW.tenant_id AND id=NEW.bill_id;
 IF po.id IS NULL OR b.id IS NULL OR po.status<>'Issued' OR b.status<>'Draft'
 OR b.purchase_order_id IS DISTINCT FROM po.id OR b.entity_id<>po.entity_id OR b.vendor_id<>po.vendor_id
 OR b.currency<>po.currency OR b.deal_id IS DISTINCT FROM po.deal_id
 OR NEW.line_index>=jsonb_array_length(po.lines) THEN RAISE EXCEPTION 'Invalid purchase order bill allocation'; END IF;
 ordered:=((po.lines->NEW.line_index->>'quantity')::numeric*1000)::bigint;
 SELECT coalesce(sum(a.quantity_millis),0) INTO allocated FROM purchase_order_bill_lines a JOIN bills x ON x.id=a.bill_id AND x.tenant_id=a.tenant_id
 WHERE a.tenant_id=NEW.tenant_id AND a.purchase_order_id=po.id AND a.line_index=NEW.line_index AND x.status<>'Voided';
 IF allocated+NEW.quantity_millis>ordered THEN RAISE EXCEPTION 'Purchase order quantity exceeded'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_order_allocation BEFORE INSERT ON purchase_order_bill_lines FOR EACH ROW EXECUTE FUNCTION order_allocation_guard();
