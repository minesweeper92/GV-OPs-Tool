ALTER TABLE memberships ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE memberships ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN auth_kind text NOT NULL DEFAULT 'sample' CHECK(auth_kind IN ('sample','oidc'));
ALTER TABLE sessions ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX user_email_normalized ON users(lower(email));
CREATE TABLE identities (
 issuer text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
 PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
);
CREATE TABLE login_attempts (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, verifier text NOT NULL, nonce text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE invitations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), email text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','finance','sales','viewer')), created_by uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, accepted_by uuid REFERENCES users(id), revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pending_invite_email ON invitations(tenant_id,lower(email)) WHERE accepted_by IS NULL AND revoked_at IS NULL;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON invitations TO gv_workspace_runtime USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT ON invitations TO gv_workspace_runtime;
CREATE TABLE database_environment (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), mode text NOT NULL CHECK(mode IN ('sample','oidc')));
-- Upgrade existing local samples without ever interpreting them as real tenants.
INSERT INTO database_environment(singleton,mode) SELECT true,'sample' WHERE EXISTS(SELECT 1 FROM tenants);
CREATE TABLE organization_requests (
 user_id uuid NOT NULL REFERENCES users(id), request_key uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
 payload jsonb NOT NULL, PRIMARY KEY(user_id,request_key)
);
