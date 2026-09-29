ALTER TABLE contacts ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE deals ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE deals ADD COLUMN version integer NOT NULL DEFAULT 1;
CREATE TRIGGER crm_version BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION crm_version_guard();
