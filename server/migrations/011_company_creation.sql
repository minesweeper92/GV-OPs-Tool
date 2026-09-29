-- Quick-create retries must select the original company, not make a duplicate.
ALTER TABLE companies ADD COLUMN creation_request_key uuid;
ALTER TABLE companies ADD COLUMN creation_payload jsonb;
CREATE UNIQUE INDEX company_creation_retry ON companies(tenant_id,creation_request_key);
