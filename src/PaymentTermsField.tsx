import { Field } from "./components";
import {
  replaceDefault,
  type PaymentTerm,
  type SalesDefaults,
} from "../shared/document-defaults";

export function PaymentTermsField({
  settings,
  value,
  onChange,
}: {
  settings: SalesDefaults;
  value: PaymentTerm | null;
  onChange: (term: PaymentTerm) => void;
}) {
  // A saved rule is a snapshot, even when its library entry has since been changed or removed.
  const matches = settings.terms.some(
    (t) => replaceDefault(value, t, null) === null,
  );
  const selected = value && !matches ? "snapshot" : (value?.id ?? "");
  return (
    <Field
      label="Payment term"
      hint="Changing the term updates the due-date rule. You can still enter a different date or wording."
    >
      <select
        value={selected}
        onChange={(e) => {
          const term = settings.terms.find((t) => t.id === e.target.value);
          if (term) onChange(term);
        }}
      >
        {!value ? <option value="">Choose a payment term</option> : null}
        {value && !matches ? (
          <option value="snapshot">{value.name} (saved/customer rule)</option>
        ) : null}
        {settings.terms.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
