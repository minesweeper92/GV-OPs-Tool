import test from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "../server/db.ts";
import { Problem, type Context } from "../server/domain.ts";
import {
  executePurchaseOrder,
  purchaseOrderSnapshot,
} from "../server/purchase-orders.ts";
import {
  executeVendorAdvance,
  vendorAdvanceSnapshot,
} from "../server/vendor-advances.ts";
import {
  executeVendorCredit,
  vendorCreditSnapshot,
} from "../server/vendor-credits.ts";
import {
  executeBillSchedule,
  billScheduleSnapshot,
} from "../server/recurring-bills.ts";

test("purchasing capability guards deny unauthorized roles before reading or writing", async () => {
  let queries = 0;
  const tx = {
    query: async () => {
      queries++;
      throw new Error("Unauthorized database access");
    },
  } as SQL;
  for (const role of ["sales", "viewer", "unknown", "Admin", "__proto__"]) {
    const ctx = {
      role,
      tenantId: "test-tenant",
      userId: "test-user",
    } as Context;
    for (const execute of [
      executePurchaseOrder,
      executeVendorAdvance,
      executeVendorCredit,
      executeBillSchedule,
    ]) {
      await assert.rejects(
        execute(tx, ctx, { action: "invalid" }),
        (error: unknown) => error instanceof Problem && error.status === 403,
      );
    }
    for (const snapshot of [
      purchaseOrderSnapshot,
      vendorAdvanceSnapshot,
      vendorCreditSnapshot,
      billScheduleSnapshot,
    ]) {
      const data = await snapshot(tx, ctx);
      for (const rows of Object.values(data)) assert.deepEqual(rows, []);
    }
  }
  assert.equal(queries, 0);
});
