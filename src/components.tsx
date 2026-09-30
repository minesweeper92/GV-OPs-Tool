import {
  useEffect,
  useRef,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { X, Plus, ArrowRight, Check, Clock, Minus } from "lucide-react";
export function Badge({ children }: { children: ReactNode }) {
  const value = String(children),
    positive = [
      "Won",
      "Paid",
      "Settled",
      "Accepted",
      "Customer",
      "Completed",
      "Posted",
    ].includes(value),
    negative = ["Lost", "Voided", "Overdue", "Declined"].includes(value);
  const Icon = positive ? Check : negative ? Minus : Clock;
  return (
    <span
      className={`badge ${positive ? "success" : negative ? "danger" : "neutral"}`}
    >
      <Icon size={12} />
      {children}
    </span>
  );
}
export function Heading({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action ? (
        <button className="primary" onClick={onAction}>
          <Plus size={17} />
          {action}
        </button>
      ) : null}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
  onAction,
}: {
  title: string;
  children: ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? (
        <button onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </button>
      ) : null}
    </div>
  );
}
export function Table({
  headers,
  children,
  label,
}: {
  headers: string[];
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className="table-scroll"
      role="region"
      aria-label={label || headers.join(", ")}
      tabIndex={0}
    >
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className={
                  /Amount|Total|Balance|Debit|Credit/.test(h) ? "num" : ""
                }
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Drawer({
  title,
  children,
  close,
  dirty,
  wide = false,
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  dirty: boolean;
  wide?: boolean;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previous.current = document.activeElement as HTMLElement;
    ref.current?.showModal();
    if (initialFocus)
      ref.current?.querySelector<HTMLElement>(initialFocus)?.focus();
    return () => {
      previous.current?.focus();
    };
  }, []);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  const attemptClose = () => {
    if (!dirty || window.confirm("Discard your unsaved changes?")) close();
  };
  return (
    <dialog
      ref={ref}
      className={`drawer${wide ? " document-editor" : ""}`}
      aria-labelledby="editor-title"
      onCancel={(e) => {
        e.preventDefault();
        attemptClose();
      }}
    >
      <div className="drawer-head">
        <h2 id="editor-title">{title}</h2>
        <button aria-label="Close editor" onClick={attemptClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(
            children as ReactElement<{
              id?: string;
              "aria-describedby"?: string;
            }>,
            { id, "aria-describedby": hint ? `${id}-hint` : undefined },
          )
        : children}
      {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return (
    <p className="error" role="alert">
      {error}
    </p>
  );
}
