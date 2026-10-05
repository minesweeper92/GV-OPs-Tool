-- 025 has already run in the persistent local preview. Promote only its newly
-- installed control account without rewriting the applied migration checksum.
-- Owner-only migration, atomic with startup; normal account writes remain guarded.
ALTER TABLE accounts DISABLE TRIGGER account_change;
UPDATE accounts SET system=true,version=version+1
 WHERE code='1350' AND name='Vendor credits receivable' AND type='Asset' AND NOT system;
ALTER TABLE accounts ENABLE TRIGGER account_change;
