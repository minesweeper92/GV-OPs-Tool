CREATE TABLE role_profiles (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 base_role text NOT NULL CHECK(base_role IN ('finance','sales','viewer')),
 capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='array'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX role_profile_name ON role_profiles(tenant_id,lower(name));
ALTER TABLE memberships ADD COLUMN role_profile_id uuid;
ALTER TABLE memberships ADD CONSTRAINT membership_role_profile FOREIGN KEY(tenant_id,role_profile_id) REFERENCES role_profiles(tenant_id,id);
ALTER TABLE invitations ADD COLUMN role_profile_id uuid;
ALTER TABLE invitations ADD CONSTRAINT invitation_role_profile FOREIGN KEY(tenant_id,role_profile_id) REFERENCES role_profiles(tenant_id,id);
ALTER TABLE role_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON role_profiles USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT ON role_profiles TO gv_workspace_runtime;
