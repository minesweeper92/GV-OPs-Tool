import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

type Blocker = { label: string; pending: boolean };
type Safety = {
  register: (id: symbol, blocker: Blocker) => () => void;
  canLeave: () => boolean;
};
const SafetyContext = createContext<Safety | null>(null);

/** Per-mounted workspace registry; no business data or cross-user singleton state. */
export function NavigationSafetyProvider({
  children,
}: {
  children: ReactNode;
}) {
  const blockers = useRef(new Map<symbol, Blocker>());
  const value = useMemo<Safety>(
    () => ({
      register(id, blocker) {
        blockers.current.set(id, blocker);
        return () => {
          blockers.current.delete(id);
        };
      },
      canLeave() {
        const entries = [...blockers.current.values()];
        const pending = entries.find((entry) => entry.pending);
        if (pending) {
          window.alert(
            `${pending.label} is still saving. Please wait before leaving.`,
          );
          return false;
        }
        return (
          !entries.length ||
          window.confirm(
            `Draft recovery is unavailable for ${entries.map((entry) => entry.label).join(", ")}. Leave and lose unsaved changes?`,
          )
        );
      },
    }),
    [],
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!blockers.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return (
    <SafetyContext.Provider value={value}>{children}</SafetyContext.Provider>
  );
}

export function useNavigationSafety() {
  const safety = useContext(SafetyContext);
  if (!safety)
    throw new Error("Navigation safety requires its workspace provider.");
  return safety;
}

export function useLeaveGuard({
  label,
  dirty,
  recoverable,
  busy,
}: {
  label: string;
  dirty: boolean;
  recoverable: boolean;
  busy: boolean;
}) {
  const { register } = useNavigationSafety();
  const id = useRef(Symbol("form-leave-guard"));
  useLayoutEffect(() => {
    if (!busy && (!dirty || recoverable)) return;
    return register(id.current, { label, pending: busy });
  }, [register, label, dirty, recoverable, busy]);
}
