ALTER TABLE entities ADD COLUMN next_bank integer NOT NULL DEFAULT 1;
INSERT INTO accounts(tenant_id,entity_id,code,name,type) SELECT tenant_id,id,'3900','Opening balance clearing','Equity' FROM entities;
CREATE TABLE bank_accounts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, account_code text NOT NULL,
 name text NOT NULL, reference text NOT NULL, currency text NOT NULL DEFAULT 'PKR' CHECK(currency='PKR'),
 opening_on date NOT NULL, opening_minor bigint NOT NULL, last_reconciled_on date NOT NULL,
 offset_code text NOT NULL, request_key uuid NOT NULL, request_payload jsonb NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,entity_id,account_code), UNIQUE(tenant_id,entity_id,name), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id,account_code) REFERENCES accounts(tenant_id,entity_id,code),
 FOREIGN KEY(tenant_id,entity_id,offset_code) REFERENCES accounts(tenant_id,entity_id,code)
);
ALTER TABLE payments ADD COLUMN bank_account_id uuid;
ALTER TABLE payments ADD FOREIGN KEY(tenant_id,entity_id,bank_account_id) REFERENCES bank_accounts(tenant_id,entity_id,id);
ALTER TABLE vendor_payments ADD COLUMN bank_account_id uuid;
ALTER TABLE vendor_payments ADD FOREIGN KEY(tenant_id,entity_id,bank_account_id) REFERENCES bank_accounts(tenant_id,entity_id,id);
ALTER TABLE expenses ADD COLUMN bank_account_id uuid;
ALTER TABLE expenses ADD FOREIGN KEY(tenant_id,entity_id,bank_account_id) REFERENCES bank_accounts(tenant_id,entity_id,id);
CREATE TABLE bank_statements (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, bank_id uuid NOT NULL, from_date date NOT NULL, to_date date NOT NULL CHECK(to_date>=from_date),
 opening_minor bigint NOT NULL, closing_minor bigint NOT NULL, reference text NOT NULL,
 status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Reconciled','Cancelled')), closed_at timestamptz,
 request_key uuid NOT NULL, request_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,bank_id,id),UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,bank_id) REFERENCES bank_accounts(tenant_id,id)
);
CREATE UNIQUE INDEX bank_active_draft ON bank_statements(tenant_id,bank_id) WHERE status='Draft';
CREATE TABLE bank_statement_lines (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,statement_id uuid NOT NULL,line_no integer NOT NULL,
 posted_on date NOT NULL,description text NOT NULL,reference text NOT NULL,amount_minor bigint NOT NULL CHECK(amount_minor<>0),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,statement_id,line_no),FOREIGN KEY(tenant_id,statement_id) REFERENCES bank_statements(tenant_id,id)
);
CREATE TABLE bank_matches (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,bank_id uuid NOT NULL,statement_id uuid NOT NULL,
 statement_line_ids uuid[] NOT NULL,journal_line_ids uuid[] NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,bank_id,statement_id) REFERENCES bank_statements(tenant_id,bank_id,id),
 CHECK(cardinality(statement_line_ids)>0 AND cardinality(journal_line_ids)>0)
);
CREATE TABLE bank_match_reversals (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,match_id uuid NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,match_id),FOREIGN KEY(tenant_id,match_id) REFERENCES bank_matches(tenant_id,id)
);
CREATE FUNCTION bank_statement_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'Draft' OR NEW.status NOT IN ('Reconciled','Cancelled') OR
 (to_jsonb(NEW)-'status'-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'closed_at') THEN RAISE EXCEPTION 'Statement history is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER bank_statement_history BEFORE UPDATE ON bank_statements FOR EACH ROW EXECUTE FUNCTION bank_statement_guard();
CREATE FUNCTION bank_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.last_reconciled_on<OLD.last_reconciled_on OR (to_jsonb(NEW)-'last_reconciled_on') IS DISTINCT FROM (to_jsonb(OLD)-'last_reconciled_on') THEN RAISE EXCEPTION 'Bank account history is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER bank_account_history BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION bank_account_guard();
CREATE FUNCTION bank_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM bank_accounts b JOIN journals j ON j.id=NEW.journal_id
 WHERE b.tenant_id=NEW.tenant_id AND b.entity_id=NEW.entity_id AND b.account_code=NEW.account_code AND j.posted_on<=b.last_reconciled_on AND j.source_type<>'bank-opening')
 THEN RAISE EXCEPTION 'Bank period already reconciled'; END IF; RETURN NEW; END $$;
CREATE TRIGGER bank_period_lock BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION bank_period_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bank_accounts','bank_statements','bank_statement_lines','bank_matches','bank_match_reversals'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO gv_workspace_runtime',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['bank_statement_lines','bank_matches','bank_match_reversals'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
GRANT UPDATE ON bank_accounts,bank_statements TO gv_workspace_runtime;
