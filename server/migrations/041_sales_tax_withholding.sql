-- Some customers (for example Nestlé Pakistan) withhold the full sales tax on
-- an invoice and remit it themselves. That is a different claim from income
-- tax withheld, so it settles the invoice into its own receivable account. A
-- payment may now be entirely withheld (no cash), but never empty.
ALTER TABLE payments ADD COLUMN sales_tax_withheld_minor bigint NOT NULL DEFAULT 0 CHECK(sales_tax_withheld_minor>=0);
ALTER TABLE payments DROP CONSTRAINT payments_amount_minor_check;
ALTER TABLE payments ADD CONSTRAINT payments_amount_minor_check CHECK(amount_minor>=0 AND amount_minor+wht_minor+sales_tax_withheld_minor>0);
INSERT INTO accounts(tenant_id,entity_id,code,name,type,system)
SELECT e.tenant_id,e.id,'1210','Sales tax withheld by customers','Asset',true FROM entities e
WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.entity_id=e.id AND a.code='1210');
