// A custom profile can narrow its template, never broaden it. Resolve profiles
// from authenticated membership on the server; never trust request-body grants.
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
export type PermissionSubject =
  | string
  | null
  | undefined
  | {
      role: string | null;
      capabilities?: readonly string[];
    };
const grants: Readonly<Record<BuiltInRole, readonly Capability[]>> = {
  admin: capabilities.map((c) => c.key),
  finance: ["books.view", "books.post", "contacts.manage"],
  sales: ["crm.sales", "contacts.manage"],
  viewer: [],
};
export function hasCapability(
  subject: PermissionSubject,
  capability: Capability,
): boolean {
  const role = typeof subject === "object" && subject ? subject.role : subject;
  if (!role || !roles.some((r) => r === role)) return false;
  const selected =
    typeof subject === "object" && subject ? subject.capabilities : undefined;
  return (
    grants[role as BuiltInRole].includes(capability) &&
    (selected === undefined || selected.includes(capability))
  );
}
export function grantedCapabilities(role: PermissionSubject): Capability[] {
  return capabilities
    .filter((c) => hasCapability(role, c.key))
    .map((c) => c.key);
}
