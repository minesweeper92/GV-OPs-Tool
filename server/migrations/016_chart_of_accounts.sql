ALTER TABLE accounts ADD COLUMN parent_code text;
ALTER TABLE accounts ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE accounts ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN system boolean NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE accounts ADD COLUMN created_request_key uuid;
ALTER TABLE accounts ADD COLUMN request_hash text;
ALTER TABLE accounts ADD CONSTRAINT account_identity UNIQUE(tenant_id,id);
ALTER TABLE accounts ADD CONSTRAINT account_creation_retry UNIQUE(tenant_id,entity_id,created_request_key);
ALTER TABLE accounts ADD CONSTRAINT account_parent_same_entity
  FOREIGN KEY(tenant_id,entity_id,parent_code) REFERENCES accounts(tenant_id,entity_id,code);
ALTER TABLE accounts ADD CONSTRAINT account_not_own_parent CHECK(parent_code IS NULL OR parent_code<>code);
UPDATE accounts SET system=true;
CREATE FUNCTION account_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_type text; parent_active boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deactivate accounts instead of deleting them'; END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.tenant_id,NEW.entity_id,NEW.id,NEW.code,NEW.type,NEW.parent_code,NEW.system,NEW.created_request_key,NEW.request_hash)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.entity_id,OLD.id,OLD.code,OLD.type,OLD.parent_code,OLD.system,OLD.created_request_key,OLD.request_hash)
   THEN RAISE EXCEPTION 'Account identity and classification are immutable'; END IF;
  IF OLD.system AND ROW(NEW.name,NEW.description,NEW.active)
    IS DISTINCT FROM ROW(OLD.name,OLD.description,OLD.active)
   THEN RAISE EXCEPTION 'System account cannot be changed'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Account version must advance by one'; END IF;
  IF OLD.active AND NOT NEW.active AND EXISTS(
    SELECT 1 FROM accounts c WHERE c.tenant_id=OLD.tenant_id AND c.entity_id=OLD.entity_id AND c.parent_code=OLD.code AND c.active
  ) THEN RAISE EXCEPTION 'Deactivate child accounts first'; END IF;
 END IF;
 IF NEW.parent_code IS NOT NULL THEN
  SELECT type,active INTO parent_type,parent_active FROM accounts
   WHERE tenant_id=NEW.tenant_id AND entity_id=NEW.entity_id AND code=NEW.parent_code;
  IF parent_type IS NULL OR parent_type<>NEW.type OR NOT parent_active
   THEN RAISE EXCEPTION 'Parent account must be active and have the same type'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_change BEFORE INSERT OR UPDATE OR DELETE ON accounts
 FOR EACH ROW EXECUTE FUNCTION account_change_guard();
