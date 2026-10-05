import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  clearBrowserDraft,
  readBrowserDraft,
  writeBrowserDraft,
  draftDetails,
} from "../src/browserDraft";
import { documentDetails } from "../shared/documents";

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
