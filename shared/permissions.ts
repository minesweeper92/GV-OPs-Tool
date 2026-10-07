// Built-in policy only. Tenant-configured roles and entity-scoped grants must
// be resolved on the server before they can replace this compatibility policy.
export const roles = ["admin", "finance", "sales", "viewer"] as const;
export type BuiltInRole = (typeof roles)[number];
export const capabilities = [
  { key: "books.view", label: "View accounting and banking" },
  { key: "books.post", label: "Record financial transactions" },
  { key: "bills.approve", label: "Approve and post vendor bills" },
  { key: "crm.sales", label: "Qualify leads and manage sales" },
  { key: "contacts.manage", label: "Maintain contacts and companies" },
  { key: "team.manage", label: "Manage team access" },
] as const;
export type Capability = (typeof capabilities)[number]["key"];
const grants: Readonly<Record<BuiltInRole, readonly Capability[]>> = {
  admin: capabilities.map((c) => c.key),
  finance: ["books.view", "books.post", "contacts.manage"],
  sales: ["crm.sales", "contacts.manage"],
  viewer: [],
};
export function hasCapability(
  role: string | null | undefined,
  capability: Capability,
): boolean {
  if (!role || !roles.some((r) => r === role)) return false;
  return grants[role as BuiltInRole].includes(capability);
}
export function grantedCapabilities(
  role: string | null | undefined,
): Capability[] {
  return capabilities
    .filter((c) => hasCapability(role, c.key))
    .map((c) => c.key);
}
