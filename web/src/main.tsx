import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/index.css";
import App from "./App";
import { DaemonProvider } from "./app/lib/daemon";
import { Activity } from "./app/pages/Activity";
import { AppHome } from "./app/pages/AppHome";
import { Help } from "./app/pages/Help";
import { HowItWorks } from "./app/pages/HowItWorks";
import { Landing } from "./app/pages/Landing";
import { Safety } from "./app/pages/Safety";
import { SwapDetail } from "./app/pages/SwapDetail";
import { usePath } from "./router";

// `/` landing, `/app` the swap card, `/app/activity` my swaps, `/app/swap/:id` one swap, `/help`
// plain answers, `/how-it-works` and `/safety` the deep explanations, `/inspect` the live
// two-party protocol view for developers.
function Root() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const swap = path.match(/^\/app\/swap\/([0-9a-fA-F]+)$/);
  if (swap) return <SwapDetail id={swap[1]} />;
  if (path === "/app") return <AppHome />;
  if (path === "/app/activity") return <Activity />;
  if (path === "/help") return <Help />;
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
