import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilities,
  roles,
  hasCapability,
  grantedCapabilities,
} from "../shared/permissions.ts";

test("built-in capability policy preserves finance, sales and approval boundaries", () => {
  assert.equal(grantedCapabilities("admin").length, capabilities.length);
  assert.deepEqual(grantedCapabilities("finance"), [
    "books.view",
    "books.post",
    "contacts.manage",
  ]);
  assert.deepEqual(grantedCapabilities("sales"), [
    "crm.sales",
    "contacts.manage",
  ]);
  assert.deepEqual(grantedCapabilities("viewer"), []);
  for (const role of roles) {
    assert.equal(hasCapability(role, "bills.approve"), role === "admin");
    assert.equal(hasCapability(role, "team.manage"), role === "admin");
  }
});
test("unknown roles and mutated returned arrays cannot grant access", () => {
  for (const value of [
    undefined,
    null,
    "",
    "administrator",
    "__proto__",
    "constructor",
    "Admin",
  ]) {
    assert.deepEqual(grantedCapabilities(value), []);
    assert.equal(hasCapability(value, "books.post"), false);
  }
  const permissions = grantedCapabilities("sales");
  permissions.push("books.post");
  assert.equal(hasCapability("sales", "books.post"), false);
});
