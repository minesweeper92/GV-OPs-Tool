-- Customer quote links are capabilities: only their SHA-256 hashes are retained.
CREATE TABLE quote_portal_links (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 quote_id uuid NOT NULL,
 contact_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE,
 recipient_email text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 response text CHECK(response IN ('Accepted','Declined')),
 response_name text,
 response_comment text,
 responded_at timestamptz,
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 CHECK ((response IS NULL AND responded_at IS NULL) OR (response IS NOT NULL AND responded_at IS NOT NULL))
);
CREATE INDEX quote_portal_links_quote ON quote_portal_links(tenant_id,quote_id,created_at DESC);
CREATE FUNCTION quote_portal_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.quote_id,NEW.contact_id,NEW.token_hash,NEW.recipient_email,NEW.expires_at,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.quote_id,OLD.contact_id,OLD.token_hash,OLD.recipient_email,OLD.expires_at,OLD.created_by,OLD.created_at)
 OR OLD.response IS NOT NULL OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
 OR (NEW.response IS NOT NULL AND (NEW.revoked_at IS NOT NULL OR NEW.response_name IS NULL OR NEW.responded_at IS NULL))
 OR (NEW.response IS NULL AND (NEW.response_name IS NOT NULL OR NEW.response_comment IS NOT NULL OR NEW.responded_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Quote link history is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_portal_history BEFORE UPDATE ON quote_portal_links FOR EACH ROW EXECUTE FUNCTION quote_portal_history_guard();
ALTER TABLE quote_portal_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON quote_portal_links TO gv_workspace_runtime
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON quote_portal_links TO gv_workspace_runtime;

ALTER TABLE quote_events DROP CONSTRAINT quote_events_kind_check;
ALTER TABLE quote_events ADD CONSTRAINT quote_events_kind_check CHECK(kind IN ('Shared','Accepted','Declined'));
