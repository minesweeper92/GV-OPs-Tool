CREATE TABLE tenants (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE users (id uuid PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL);
CREATE TABLE memberships (tenant_id uuid REFERENCES tenants(id), user_id uuid REFERENCES users(id), role text NOT NULL CHECK(role IN ('admin','finance','sales','viewer')), PRIMARY KEY(tenant_id,user_id));
CREATE TABLE sessions (hash text PRIMARY KEY, user_id uuid REFERENCES users(id), tenant_id uuid REFERENCES tenants(id), csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE entities (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, code text NOT NULL,
 currency text NOT NULL DEFAULT 'PKR' CHECK(currency='PKR'), country text NOT NULL DEFAULT 'PK',
 tax_id text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '', lock_date date,
 next_invoice integer NOT NULL DEFAULT 1, UNIQUE(tenant_id,id), UNIQUE(tenant_id,code)
);
CREATE TABLE companies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, domain text NOT NULL DEFAULT '',
 industry text NOT NULL DEFAULT '', tax_id text NOT NULL DEFAULT '', address text NOT NULL DEFAULT '',
 customer boolean NOT NULL DEFAULT false, vendor boolean NOT NULL DEFAULT false,
 service_entity_id uuid, owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,name), FOREIGN KEY(tenant_id,service_entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TABLE contacts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), first_name text NOT NULL, last_name text NOT NULL DEFAULT '',
 email text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '',
 lifecycle text NOT NULL DEFAULT 'Lead', source text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
 owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX contact_email_unique ON contacts(tenant_id,lower(email)) WHERE email<>'';
CREATE TABLE affiliations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), contact_id uuid NOT NULL, company_id uuid NOT NULL,
 role text NOT NULL, work_email text NOT NULL DEFAULT '', started_on date NOT NULL, ended_on date,
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id), FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id),
 CHECK(ended_on IS NULL OR ended_on>=started_on)
);
CREATE UNIQUE INDEX active_affiliation ON affiliations(tenant_id,contact_id,company_id) WHERE ended_on IS NULL;
CREATE TABLE leads (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), company_id uuid NOT NULL, contact_id uuid NOT NULL,
 entity_id uuid NOT NULL, title text NOT NULL, source text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'New',
 next_action text NOT NULL, due_date date NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), CHECK(status IN ('New','Connected','Converted','Disqualified')),
 FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id), FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TABLE deals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), company_id uuid NOT NULL, contact_id uuid NOT NULL,
 entity_id uuid NOT NULL, lead_id uuid, name text NOT NULL, stage text NOT NULL DEFAULT 'Qualified', next_action text, due_date date,
 owner_id uuid NOT NULL REFERENCES users(id), accepted_quote_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,lead_id), UNIQUE(tenant_id,entity_id,id),
 CHECK(stage IN ('Qualified','Proposal','Negotiation','Won','Lost')), CHECK(stage IN ('Won','Lost') OR (length(next_action)>0 AND due_date IS NOT NULL)),
 FOREIGN KEY(tenant_id,company_id) REFERENCES companies(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id), FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id)
);
CREATE TABLE quotes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), deal_id uuid NOT NULL, entity_id uuid NOT NULL,
 option_name text NOT NULL, revision integer NOT NULL CHECK(revision>0), currency text NOT NULL CHECK(currency IN ('PKR','USD','AED','EUR','GBP')), fx_micros bigint NOT NULL CHECK(fx_micros>0),
 lines jsonb NOT NULL, net_minor bigint NOT NULL CHECK(net_minor>=0), tax_minor bigint NOT NULL CHECK(tax_minor>=0), total_minor bigint NOT NULL CHECK(total_minor=net_minor+tax_minor AND total_minor>0),
 customer_name text NOT NULL, issuer_name text NOT NULL, issuer_address text NOT NULL, issuer_tax_id text NOT NULL,
 terms text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users(id),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,deal_id,id), UNIQUE(tenant_id,deal_id,option_name,revision), CHECK(currency<>'PKR' OR fx_micros=1000000),
 FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
ALTER TABLE deals ADD FOREIGN KEY(tenant_id,id,accepted_quote_id) REFERENCES quotes(tenant_id,deal_id,id);
CREATE TABLE quote_events (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, quote_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('Shared','Accepted')), reference text NOT NULL, actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,quote_id) REFERENCES quotes(tenant_id,id));
CREATE TABLE invoices (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, deal_id uuid NOT NULL, quote_id uuid NOT NULL,
 number text, status text NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Issued','Paid','Voided')), issue_date date NOT NULL, due_date date NOT NULL,
 paid_minor bigint NOT NULL DEFAULT 0 CHECK(paid_minor>=0), paid_base_minor bigint NOT NULL DEFAULT 0 CHECK(paid_base_minor>=0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,deal_id), UNIQUE(tenant_id,entity_id,number), CHECK(due_date>=issue_date),
 FOREIGN KEY(tenant_id,deal_id,quote_id) REFERENCES quotes(tenant_id,deal_id,id), FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE TABLE payments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, invoice_id uuid NOT NULL, payment_date date NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), wht_minor bigint NOT NULL DEFAULT 0 CHECK(wht_minor>=0), fx_micros bigint NOT NULL CHECK(fx_micros>0),
 reference text NOT NULL, request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key), FOREIGN KEY(tenant_id,entity_id,invoice_id) REFERENCES invoices(tenant_id,entity_id,id)
);
CREATE FUNCTION invoice_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.entity_id,NEW.deal_id,NEW.quote_id,NEW.issue_date,NEW.due_date,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.entity_id,OLD.deal_id,OLD.quote_id,OLD.issue_date,OLD.due_date,OLD.created_at)
 OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number)
 THEN RAISE EXCEPTION 'Invoice history is immutable'; END IF;
 IF OLD.status IN ('Paid','Voided') THEN RAISE EXCEPTION 'A closed invoice cannot be changed'; END IF;
 IF (OLD.status='Draft' AND NEW.status<>'Issued') OR (OLD.status='Issued' AND NEW.status NOT IN ('Issued','Paid','Voided'))
 THEN RAISE EXCEPTION 'Invalid invoice status transition'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER invoice_history BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoice_history_guard();
CREATE TABLE expenses (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, deal_id uuid, description text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0), expense_date date NOT NULL, reference text NOT NULL,
 request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id), UNIQUE(tenant_id,request_key),
 FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id), FOREIGN KEY(tenant_id,entity_id,deal_id) REFERENCES deals(tenant_id,entity_id,id)
);
CREATE TABLE accounts (tenant_id uuid NOT NULL, entity_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, type text NOT NULL CHECK(type IN ('Asset','Liability','Equity','Income','Expense')), PRIMARY KEY(tenant_id,entity_id,code), FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id));
CREATE TABLE journals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, source_type text NOT NULL, source_id uuid NOT NULL,
 posted_on date NOT NULL, description text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), created_tx bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,entity_id,id), UNIQUE(tenant_id,source_type,source_id), FOREIGN KEY(tenant_id,entity_id) REFERENCES entities(tenant_id,id)
);
CREATE TABLE journal_lines (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, entity_id uuid NOT NULL, journal_id uuid NOT NULL, account_code text NOT NULL,
 debit_minor bigint NOT NULL DEFAULT 0, credit_minor bigint NOT NULL DEFAULT 0,
 CHECK((debit_minor>0 AND credit_minor=0) OR (credit_minor>0 AND debit_minor=0)),
 FOREIGN KEY(tenant_id,entity_id,journal_id) REFERENCES journals(tenant_id,entity_id,id), FOREIGN KEY(tenant_id,entity_id,account_code) REFERENCES accounts(tenant_id,entity_id,code)
);
CREATE TABLE audit_events (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor_id uuid NOT NULL REFERENCES users(id), record_id uuid NOT NULL, action text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Record is immutable. Create a revision or reversal.'; END $$;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['quotes','quote_events','payments','expenses','journals','journal_lines','audit_events'] LOOP
 EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION immutable_record()',t);
 END LOOP; END $$;
CREATE FUNCTION balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE target uuid; n integer; difference numeric;
 BEGIN
 IF TG_TABLE_NAME='journals' THEN target:=NEW.id; ELSE target:=NEW.journal_id; END IF;
 SELECT count(*),coalesce(sum(debit_minor-credit_minor),0) INTO n,difference FROM journal_lines WHERE journal_id=target AND tenant_id=NEW.tenant_id;
 IF n<2 OR difference<>0 THEN RAISE EXCEPTION 'Journal must have at least two balanced lines'; END IF;
 RETURN NULL;
 END $$;
CREATE CONSTRAINT TRIGGER balance_header AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION balanced_journal();
CREATE CONSTRAINT TRIGGER balance_lines AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION balanced_journal();
CREATE FUNCTION prevent_late_lines() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM journals WHERE id=NEW.journal_id AND tenant_id=NEW.tenant_id AND created_tx=txid_current()) THEN RAISE EXCEPTION 'Cannot append lines to a committed journal'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER sealed_journal BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION prevent_late_lines();
CREATE FUNCTION lock_posting() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM entities WHERE id=NEW.entity_id AND tenant_id=NEW.tenant_id AND lock_date>=NEW.posted_on) THEN RAISE EXCEPTION 'Posting date is in a locked accounting period'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER period_lock BEFORE INSERT ON journals FOR EACH ROW EXECUTE FUNCTION lock_posting();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gv_workspace_runtime') THEN CREATE ROLE gv_workspace_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gv_workspace_runtime' AND (rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe runtime role'; END IF;
 EXECUTE format('GRANT gv_workspace_runtime TO %I',current_user);
END $$;
GRANT USAGE ON SCHEMA public TO gv_workspace_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['memberships','entities','companies','contacts','affiliations','leads','deals','quotes','quote_events','invoices','payments','expenses','accounts','journals','journal_lines','audit_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON %I TO gv_workspace_runtime USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO gv_workspace_runtime',t);
 EXECUTE format('CREATE INDEX ON %I (tenant_id)',t);
 END LOOP;
END $$;
REVOKE INSERT,UPDATE ON memberships FROM gv_workspace_runtime;
REVOKE UPDATE ON quotes,quote_events,payments,expenses,journals,journal_lines,audit_events FROM gv_workspace_runtime;
