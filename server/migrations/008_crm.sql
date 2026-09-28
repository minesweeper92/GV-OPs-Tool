ALTER TABLE contacts ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE contacts ADD COLUMN additional_emails jsonb NOT NULL DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN additional_phones jsonb NOT NULL DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN address text NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN social_url text NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE contacts ADD COLUMN currency text NOT NULL DEFAULT 'PKR';
ALTER TABLE contacts ADD COLUMN service_entity_id uuid;
ALTER TABLE contacts ADD FOREIGN KEY(tenant_id,service_entity_id) REFERENCES entities(tenant_id,id);
ALTER TABLE contacts ADD COLUMN marketing_consent text NOT NULL DEFAULT 'Unknown' CHECK(marketing_consent IN ('Unknown','Opted in','Opted out'));
ALTER TABLE contacts ADD COLUMN consent_date date;
ALTER TABLE contacts ADD COLUMN consent_source text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN trading_name text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN shipping_address text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN size text NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN disqualified_reason text NOT NULL DEFAULT '';
ALTER TABLE leads ALTER COLUMN next_action DROP NOT NULL;
ALTER TABLE leads ALTER COLUMN due_date DROP NOT NULL;
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='leads'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP EXECUTE format('ALTER TABLE leads DROP CONSTRAINT %I',c.conname); END LOOP; END $$;
ALTER TABLE leads ADD CHECK(status IN ('New','Attempted','Connected','Qualified','Converted','Disqualified'));
ALTER TABLE leads ADD CHECK(status IN ('Converted','Disqualified') OR (length(next_action)>0 AND due_date IS NOT NULL));
CREATE FUNCTION crm_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.version:=OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER crm_version BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION crm_version_guard();
CREATE TRIGGER crm_version BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION crm_version_guard();
CREATE TRIGGER crm_version BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION crm_version_guard();
CREATE TABLE contact_email_addresses(tenant_id uuid NOT NULL,contact_id uuid NOT NULL,email text NOT NULL,PRIMARY KEY(tenant_id,email),FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id));
INSERT INTO contact_email_addresses SELECT tenant_id,id,lower(email) FROM contacts WHERE email<>'';
CREATE FUNCTION contact_email_index() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 DELETE FROM contact_email_addresses WHERE tenant_id=NEW.tenant_id AND contact_id=NEW.id;
 IF NEW.email<>'' THEN INSERT INTO contact_email_addresses VALUES(NEW.tenant_id,NEW.id,lower(NEW.email)); END IF;
 INSERT INTO contact_email_addresses SELECT NEW.tenant_id,NEW.id,lower(value->>'value') FROM jsonb_array_elements(NEW.additional_emails);
 RETURN NEW; END $$;
CREATE TRIGGER contact_email_index AFTER INSERT OR UPDATE OF email,additional_emails ON contacts FOR EACH ROW EXECUTE FUNCTION contact_email_index();
CREATE TABLE crm_activities(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,record_type text NOT NULL CHECK(record_type IN ('contact','company','lead','deal')),record_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('Call','Meeting','Email','Note')),subject text NOT NULL,body text NOT NULL DEFAULT '',occurred_at timestamptz NOT NULL,outcome text NOT NULL DEFAULT '',reference_url text NOT NULL DEFAULT '',
 actor_id uuid NOT NULL REFERENCES users(id),request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key)
);
CREATE TABLE crm_tasks(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,record_type text NOT NULL CHECK(record_type IN ('contact','company','lead','deal')),record_id uuid NOT NULL,
 title text NOT NULL,notes text NOT NULL DEFAULT '',due_at timestamptz NOT NULL,priority text NOT NULL CHECK(priority IN ('Low','Normal','High')),
 assignee_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES users(id),status text NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Done','Cancelled')),
 completed_at timestamptz,version integer NOT NULL DEFAULT 1,request_key uuid NOT NULL,request_payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,request_key),FOREIGN KEY(tenant_id,assignee_id) REFERENCES memberships(tenant_id,user_id)
);
CREATE TRIGGER crm_version BEFORE UPDATE ON crm_tasks FOR EACH ROW EXECUTE FUNCTION crm_version_guard();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON crm_activities FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION crm_record_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE present boolean; BEGIN
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE tenant_id=$1 AND id=$2)',CASE NEW.record_type WHEN 'contact' THEN 'contacts' WHEN 'company' THEN 'companies' WHEN 'lead' THEN 'leads' ELSE 'deals' END) INTO present USING NEW.tenant_id,NEW.record_id;
 IF NOT present THEN RAISE EXCEPTION 'CRM record link is invalid'; END IF;
 IF TG_OP='UPDATE' THEN
 IF ROW(NEW.id,NEW.tenant_id,NEW.record_type,NEW.record_id,NEW.created_by,NEW.request_key,NEW.request_payload,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.record_type,OLD.record_id,OLD.created_by,OLD.request_key,OLD.request_payload,OLD.created_at) THEN RAISE EXCEPTION 'Task identity is immutable'; END IF;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER crm_link BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION crm_record_link();
CREATE TRIGGER crm_link BEFORE INSERT OR UPDATE ON crm_tasks FOR EACH ROW EXECUTE FUNCTION crm_record_link();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['contact_email_addresses','crm_activities','crm_tasks'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 END LOOP;END $$;
GRANT UPDATE ON crm_tasks TO gv_workspace_runtime;
GRANT DELETE ON contact_email_addresses TO gv_workspace_runtime;
CREATE INDEX crm_tasks_due ON crm_tasks(tenant_id,assignee_id,status,due_at);
CREATE INDEX crm_activities_record ON crm_activities(tenant_id,record_type,record_id,occurred_at DESC);
