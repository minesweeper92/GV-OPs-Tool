ALTER TABLE journals ADD COLUMN external_reference text NOT NULL DEFAULT '';
ALTER TABLE journals ADD COLUMN memo text NOT NULL DEFAULT '';
ALTER TABLE journals ADD COLUMN request_hash text;
ALTER TABLE journals ADD COLUMN reverses_journal_id uuid;
ALTER TABLE journals ADD CONSTRAINT journals_reversal_same_entity
  FOREIGN KEY(tenant_id,entity_id,reverses_journal_id)
  REFERENCES journals(tenant_id,entity_id,id);
CREATE UNIQUE INDEX one_reversal_per_journal ON journals(tenant_id,reverses_journal_id)
  WHERE reverses_journal_id IS NOT NULL;
ALTER TABLE journal_lines ADD COLUMN memo text NOT NULL DEFAULT '';
ALTER TABLE journal_lines ADD COLUMN line_number integer NOT NULL DEFAULT 0;
