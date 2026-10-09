import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { NavigationSafetyProvider } from "./NavigationSafety";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "./styles.css";
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="loading">
        <h1>The workspace could not render.</h1>
        <p>Your saved records are unchanged.</p>
        <button onClick={() => location.reload()}>Reload workspace</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, refetchOnWindowFocus: false, retry: 1 },
  },
});
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <QueryClientProvider client={client}>
        <NavigationSafetyProvider>
          <App />
        </NavigationSafetyProvider>
      </QueryClientProvider>
    </Boundary>
  </StrictMode>,
);
