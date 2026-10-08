ALTER TABLE entities ADD COLUMN bill_finance_limit_minor bigint CHECK(bill_finance_limit_minor>=0);
ALTER TABLE entities ADD COLUMN bill_separate_approver boolean NOT NULL DEFAULT false;
ALTER TABLE entities ADD COLUMN bill_approval_version integer NOT NULL DEFAULT 1 CHECK(bill_approval_version>0);
