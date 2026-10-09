-- Runtime cannot read the identity table directly. Expose names only for active
-- members of its transaction-scoped tenant, never emails or other tenants.
CREATE FUNCTION gv_approval_directory() RETURNS TABLE(id uuid,name text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT u.id,u.name FROM public.users u
 JOIN public.memberships m ON m.user_id=u.id
 WHERE m.active AND m.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
REVOKE ALL ON FUNCTION gv_approval_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gv_approval_directory() TO gv_workspace_runtime;
