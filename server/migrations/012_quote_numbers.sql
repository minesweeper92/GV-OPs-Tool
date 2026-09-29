-- Stable quote references, numbered independently for each issuing entity.
ALTER TABLE entities ADD COLUMN next_quote_number bigint NOT NULL DEFAULT 1;
ALTER TABLE quotes ADD COLUMN number text;

-- Existing quote versions remain immutable and retain their existing references.
-- Only quotes created after this migration receive a generated number.

CREATE UNIQUE INDEX quote_entity_number ON quotes(tenant_id,entity_id,number);
