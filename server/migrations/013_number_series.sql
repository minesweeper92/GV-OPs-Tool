CREATE TABLE number_series (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 entity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('quote','invoice')),
 name text NOT NULL,
 prefix text NOT NULL CHECK(prefix ~ '^[A-Za-z][A-Za-z0-9/_-]{0,19}$'),
 padding integer NOT NULL CHECK(padding BETWEEN 1 AND 12),
 next_number bigint NOT NULL CHECK(next_number BETWEEN 1 AND 999999999999),
 is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,entity_id,kind,prefix),
 UNIQUE(tenant_id,entity_id,kind,name),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE UNIQUE INDEX one_default_number_series ON number_series(tenant_id,entity_id,kind) WHERE is_default;
INSERT INTO number_series(id,tenant_id,entity_id,kind,name,prefix,padding,next_number,is_default)
 SELECT gen_random_uuid(),tenant_id,id,'quote','Standard','QT-',6,next_quote_number,true FROM entities;
INSERT INTO number_series(id,tenant_id,entity_id,kind,name,prefix,padding,next_number,is_default)
 SELECT gen_random_uuid(),tenant_id,id,'invoice','Standard',code || '-INV-',5,next_invoice,true FROM entities;
CREATE TABLE invoice_delivery_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 invoice_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('Sent')),
 reference text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES invoices(tenant_id,id)
);
CREATE TRIGGER immutable_invoice_delivery BEFORE UPDATE OR DELETE ON invoice_delivery_events FOR EACH ROW EXECUTE FUNCTION immutable_record();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['number_series','invoice_delivery_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO gv_workspace_runtime',t);
 END LOOP;
END $$;
