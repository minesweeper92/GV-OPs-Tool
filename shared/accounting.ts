// Dedicated sub-ledgers own these balances; free-form journals must not bypass them.
export const controlledAccountCodes = new Set([
  "1000",
  "1100",
  "1200",
  "1210",
  "1300",
  "2000",
  "2100",
  "2200",
  "2300",
  "2400",
  "2410",
  "3900",
]);
