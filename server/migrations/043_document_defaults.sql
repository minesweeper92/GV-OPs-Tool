-- New companies inherit the explicitly chosen issuing entity's terms. Existing JSON profiles stay unchanged.
ALTER TABLE companies ALTER COLUMN profile SET DEFAULT '{"payment_terms_mode":"entity"}'::jsonb;
CREATE TABLE document_defaults (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), entity_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 UNIQUE(tenant_id,entity_id), FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TABLE document_defaults_history (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), entity_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), request_key uuid NOT NULL, payload jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), actor_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_key), UNIQUE(tenant_id,entity_id,version),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON document_defaults_history FOR EACH ROW EXECUTE FUNCTION immutable_record();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['document_defaults','document_defaults_history'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE POLICY entity_scope ON %I AS RESTRICTIVE TO gv_workspace_runtime USING(gv_entity_visible(entity_id))',t);
 END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON document_defaults TO gv_workspace_runtime;
GRANT SELECT,INSERT ON document_defaults_history TO gv_workspace_runtime;
