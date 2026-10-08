-- A member may be limited to some legal entities. NULL means every entity;
-- administrators are never limited. Contacts, companies, catalog items and the
-- audit feed stay organization-wide by decision (8-Oct-2026).
ALTER TABLE memberships ADD COLUMN entity_ids uuid[];
ALTER TABLE memberships ADD CONSTRAINT membership_entity_scope
 CHECK(entity_ids IS NULL OR (role<>'admin' AND cardinality(entity_ids) BETWEEN 1 AND 100));
ALTER TABLE invitations ADD COLUMN entity_ids uuid[];
ALTER TABLE invitations ADD CONSTRAINT invitation_entity_scope
 CHECK(entity_ids IS NULL OR (role<>'admin' AND cardinality(entity_ids) BETWEEN 1 AND 100));

-- The gateway sets app.entity_ids per transaction from the authenticated
-- membership. Empty means unrestricted (administrators, workers, portal).
CREATE FUNCTION gv_entity_visible(e uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT e IS NULL
  OR coalesce(current_setting('app.entity_ids',true),'')=''
  OR e=ANY(string_to_array(current_setting('app.entity_ids',true),',')::uuid[])
$$;

CREATE POLICY entity_scope ON entities AS RESTRICTIVE TO gv_workspace_runtime
 USING (gv_entity_visible(id));

DO $$
DECLARE
 t text;
 scoped text[] := ARRAY[]::text[];
 grew boolean := true;
 r record;
 checks text;
BEGIN
 -- Rows carrying an entity_id are visible only inside the member's entities.
 FOR t IN
  SELECT c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
  WHERE c.relkind='r' AND c.relrowsecurity AND c.relname<>'entities'
   AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='entity_id' AND NOT a.attisdropped)
 LOOP
  EXECUTE format('CREATE POLICY entity_scope ON %I AS RESTRICTIVE TO gv_workspace_runtime USING (gv_entity_visible(entity_id))',t);
  scoped := scoped || t;
 END LOOP;
 -- Child rows without an entity_id inherit visibility from every scoped parent
 -- they reference, so lines, applications and reversals cannot leak.
 WHILE grew LOOP
  grew := false;
  FOR t IN
   SELECT DISTINCT c.relname FROM pg_constraint k
   JOIN pg_class c ON c.oid=k.conrelid
   JOIN pg_class p ON p.oid=k.confrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=current_schema()
   WHERE k.contype='f' AND c.relrowsecurity AND p.relname=ANY(scoped)
    AND NOT c.relname=ANY(scoped)
  LOOP
   checks := NULL;
   FOR r IN
    SELECT p.relname AS parent,
     (SELECT string_agg(format('p.%I=%I.%I',pa.attname,t,ca.attname),' AND ')
      FROM unnest(k.conkey,k.confkey) AS u(ck,pk)
      JOIN pg_attribute ca ON ca.attrelid=k.conrelid AND ca.attnum=u.ck
      JOIN pg_attribute pa ON pa.attrelid=k.confrelid AND pa.attnum=u.pk) AS joins,
     (SELECT string_agg(format('%I.%I IS NULL',t,ca.attname),' OR ')
      FROM unnest(k.conkey) AS u(ck)
      JOIN pg_attribute ca ON ca.attrelid=k.conrelid AND ca.attnum=u.ck
      WHERE ca.attname<>'tenant_id') AS nulls
    FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_class p ON p.oid=k.confrelid
    WHERE k.contype='f' AND c.relname=t AND p.relname=ANY(scoped)
   LOOP
    checks := concat_ws(' AND ', checks,
     format('(%s OR EXISTS(SELECT 1 FROM %I p WHERE %s))', r.nulls, r.parent, r.joins));
   END LOOP;
   EXECUTE format('CREATE POLICY entity_scope ON %I AS RESTRICTIVE TO gv_workspace_runtime USING (%s)',
    t, checks);
   scoped := scoped || t;
   grew := true;
  END LOOP;
 END LOOP;
 -- CRM tasks and activities point at a lead or deal by type, not by key.
 FOREACH t IN ARRAY ARRAY['crm_tasks','crm_activities'] LOOP
  EXECUTE format($p$CREATE POLICY entity_scope ON %1$I AS RESTRICTIVE TO gv_workspace_runtime USING (
   CASE %1$I.record_type
    WHEN 'lead' THEN EXISTS(SELECT 1 FROM leads p WHERE p.tenant_id=%1$I.tenant_id AND p.id=%1$I.record_id)
    WHEN 'deal' THEN EXISTS(SELECT 1 FROM deals p WHERE p.tenant_id=%1$I.tenant_id AND p.id=%1$I.record_id)
    ELSE true END)$p$, t);
 END LOOP;
END $$;
