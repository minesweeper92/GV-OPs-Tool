ALTER TABLE credit_notes ADD COLUMN adjustment_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE credit_notes ADD COLUMN adjustment_base_minor bigint NOT NULL DEFAULT 0;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='credit_notes'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%net_minor%' OR pg_get_constraintdef(oid) LIKE '%base_minor%')
 LOOP EXECUTE format('ALTER TABLE credit_notes DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE credit_notes ADD CHECK(net_minor>=0);
ALTER TABLE credit_notes ADD CHECK(net_base_minor>=0 AND tax_base_minor>=0);
ALTER TABLE credit_notes ADD CHECK(total_minor=net_minor+tax_minor+adjustment_minor AND total_minor>0);
ALTER TABLE credit_notes ADD CHECK(base_minor=net_base_minor+tax_base_minor+adjustment_base_minor AND base_minor>0);
