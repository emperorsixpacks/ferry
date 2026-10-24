import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/index.css";
import App from "./App";
import { DaemonProvider } from "./app/lib/daemon";
import { AppHome } from "./app/pages/AppHome";
import { HowItWorks } from "./app/pages/HowItWorks";
import { Landing } from "./app/pages/Landing";
import { Safety } from "./app/pages/Safety";
import { SwapDetail } from "./app/pages/SwapDetail";
import { usePath } from "./router";

// `/` landing, `/app` swap form and my swaps, `/app/swap/:id` one swap, `/how-it-works` the
// plain-language docs, `/safety` the threat model, `/inspect` the live two-party protocol view for developers.
function Root() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const swap = path.match(/^\/app\/swap\/([0-9a-fA-F]+)$/);
  if (swap) return <SwapDetail id={swap[1]} />;
  if (path === "/app") return <AppHome />;
  if (path === "/how-it-works") return <HowItWorks />;
  if (path === "/safety") return <Safety />;
  if (path === "/inspect") return <App />;
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DaemonProvider>
      <Root />
    </DaemonProvider>
  </StrictMode>,
);
