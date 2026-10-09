import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  clearBrowserDraft,
  readBrowserDraft,
  writeBrowserDraft,
  draftDetails,
  bankTransactionDraft,
  bankTransactionDraftKey,
  journalEntryDraft,
  journalEntryDraftKey,
  accountEntryDraft,
  accountEntryDraftKey,
} from "../src/browserDraft";
import { documentDetails } from "../shared/documents";

test("bank draft keeps incomplete allocations and retry identity, isolated by organization, user, entity and bank", () => {
  const storage = memoryStorage();
  const key = bankTransactionDraftKey("org", "user", "entity", "bank");
  const draft = {
    direction: "out",
    amount: "1.",
    description: "Draft",
    date: "",
    reference: "",
    hint: "",
    requestKey: crypto.randomUUID(),
    lines: [{ account_code: "", debit: "-", credit: "", memo: "unfinished" }],
  };
  writeBrowserDraft(key, draft, storage);
  const recovered = readBrowserDraft(key, bankTransactionDraft, storage);
  assert.equal(recovered?.lines[0].debit, "-");
  assert.equal(recovered?.requestKey, draft.requestKey);
  for (const parts of [
    ["other", "user", "entity", "bank"],
    ["org", "other", "entity", "bank"],
    ["org", "user", "other", "bank"],
    ["org", "user", "entity", "other"],
  ]) {
    assert.equal(
      readBrowserDraft(
        bankTransactionDraftKey(parts[0], parts[1], parts[2], parts[3]),
        bankTransactionDraft,
        storage,
      ),
      null,
    );
  }
});

test("recovery preserves incomplete amounts, recipients and references without weakening save validation", () => {
  const details = {
    ...documentDetails.parse({}),
    adjustment_amount: "-",
    shipping_amount: "",
    recipients: ["unfinished@"],
    references: [{ name: "", url: "https:" }],
  };
  assert.deepEqual(draftDetails.parse(details), details);
  assert.equal(documentDetails.safeParse(details).success, false);
});

const schema = z.object({ savedAt: z.number(), text: z.string() });
test("account drafts isolate identity/entity and retain original edit versions and incomplete codes", () => {
  const storage = memoryStorage();
  const key = accountEntryDraftKey("org", "owner", "pvt");
  const draft = {
    mode: "edit",
    selected: { code: "5400", version: 2 },
    code: "5400",
    name: "",
    type: "Expense",
    parent: "5000",
    description: "Unsaved",
    requestKey: crypto.randomUUID(),
  };
  writeBrowserDraft(key, draft, storage);
  assert.equal(
    readBrowserDraft(key, accountEntryDraft, storage)?.selected?.version,
    2,
  );
  for (const parts of [
    ["other", "owner", "pvt"],
    ["org", "other", "pvt"],
    ["org", "owner", "aop"],
  ]) {
    assert.equal(
      readBrowserDraft(
        accountEntryDraftKey(parts[0], parts[1], parts[2]),
        accountEntryDraft,
        storage,
      ),
      null,
    );
  }
  writeBrowserDraft(
    key,
    { ...draft, mode: "create", selected: null, code: "A" },
    storage,
  );
  assert.equal(readBrowserDraft(key, accountEntryDraft, storage)?.code, "A");
  assert.equal(
    accountEntryDraft.safeParse({
      ...draft,
      savedAt: Date.now(),
      selected: null,
    }).success,
    false,
  );
});
test("journal drafts preserve incomplete schedules and remain separate from manual entries", () => {
  const storage = memoryStorage();
  const key = journalEntryDraftKey("org", "user", "entity", "schedules");
  const draft = {
    date: "",
    reference: "",
    requestKey: crypto.randomUUID(),
    lines: [{ account_code: "", debit: ".", credit: "", memo: "" }],
    memo: "",
    autoReverseOn: "",
    scheduleName: "Incomplete",
    frequency: "quarterly",
    timezone: "UTC",
    endDate: "",
    occurrences: "",
    reverseNextMonth: true,
  };
  writeBrowserDraft(key, draft, storage);
  assert.equal(
    readBrowserDraft(key, journalEntryDraft, storage)?.lines[0].debit,
    ".",
  );
  assert.equal(
    readBrowserDraft(key, journalEntryDraft, storage)?.frequency,
    "quarterly",
  );
  assert.equal(
    readBrowserDraft(
      journalEntryDraftKey("org", "user", "entity", "manual"),
      journalEntryDraft,
      storage,
    ),
    null,
  );
});
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("browser drafts round-trip only at their exact scoped key and clear explicitly", () => {
  const storage = memoryStorage();
  assert.equal(
    writeBrowserDraft("tenant-a:user-a:invoice", { text: "Draft" }, storage),
    true,
  );
  assert.equal(
    readBrowserDraft("tenant-a:user-a:invoice", schema, storage)?.text,
    "Draft",
  );
  assert.equal(
    readBrowserDraft("tenant-b:user-a:invoice", schema, storage),
    null,
  );
  assert.equal(
    readBrowserDraft("tenant-a:user-b:invoice", schema, storage),
    null,
  );
  clearBrowserDraft("tenant-a:user-a:invoice", storage);
  assert.equal(
    readBrowserDraft("tenant-a:user-a:invoice", schema, storage),
    null,
  );
});

test("draft recovery ignores malformed, incompatible, expired and future data", () => {
  const storage = memoryStorage();
  for (const raw of [
    "{",
    JSON.stringify({ savedAt: Date.now(), text: 123 }),
    JSON.stringify({ savedAt: Date.now() - 86400001, text: "Expired" }),
    JSON.stringify({ savedAt: Date.now() + 60000, text: "Future" }),
    "x".repeat(256001),
  ]) {
    storage.setItem("key", raw);
    assert.equal(readBrowserDraft("key", schema, storage), null);
  }
});

test("storage failures never interrupt a form and oversized saves remove the stale draft", () => {
  const blocked = {
    getItem: () => {
      throw Error("Denied");
    },
    setItem: () => {
      throw Error("Quota");
    },
    removeItem: () => {
      throw Error("Denied");
    },
  };
  assert.equal(readBrowserDraft("key", schema, blocked), null);
  assert.equal(writeBrowserDraft("key", { text: "Draft" }, blocked), false);
  assert.doesNotThrow(() => clearBrowserDraft("key", blocked));
  const storage = memoryStorage();
  writeBrowserDraft("key", { text: "Previous" }, storage);
  assert.equal(
    writeBrowserDraft("key", { text: "x".repeat(256001) }, storage),
    false,
  );
  assert.equal(storage.getItem("key"), null);
});
