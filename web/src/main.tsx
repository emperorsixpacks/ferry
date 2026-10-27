import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/index.css";
import App from "./App";
import { DaemonProvider } from "./app/lib/daemon";
import { NearProvider } from "./app/lib/near";
import { RoutesProvider } from "./app/lib/routes";
import { Activity } from "./app/pages/Activity";
import { AppHome } from "./app/pages/AppHome";
import { ComboDetail } from "./app/pages/ComboDetail";
import { Help } from "./app/pages/Help";
import { HowItWorks } from "./app/pages/HowItWorks";
import { Landing } from "./app/pages/Landing";
import { NearDetail } from "./app/pages/NearDetail";
import { Privacy } from "./app/pages/Privacy";
import { Ramp } from "./app/pages/Ramp";
import { WalletPage } from "./app/pages/Wallet";
import { RouteDetail } from "./app/pages/RouteDetail";
import { RunNode } from "./app/pages/RunNode";
import { Safety } from "./app/pages/Safety";
import { SwapDetail } from "./app/pages/SwapDetail";
import { usePath } from "./router";

// `/` landing, `/app` the swap card, `/app/activity` my swaps, `/app/swap/:id` one swap,
// `/app/route/:id` one private swap (coin → shielded ZEC → coin), `/app/near/:id` one NEAR Intents
// swap (shielded ZEC for any of its assets, or the other way), `/app/combo/:id` one private swap
// with NEAR Intents at an end, `/wallet` the node's coins (add funds, send them to your own
// wallet), `/ramp` Naira on- and off-ramp (not available yet; not linked from the header),
// `/run-a-node` how to run your own node, `/help` plain answers, `/how-it-works` and `/safety` the
// deep explanations, `/privacy` what a chain analyst sees of one swap done four ways (a bridge,
// NEAR Intents, Ferry, a Ferry route), `/inspect` the live two-party protocol view for developers.
function Root() {
  const path = usePath().replace(/\/+$/, "") || "/";
  const swap = path.match(/^\/app\/swap\/([0-9a-fA-F]+)$/);
  if (swap) return <SwapDetail id={swap[1]} />;
  const route = path.match(/^\/app\/route\/(r[0-9a-f]+)$/);
  if (route) return <RouteDetail id={route[1]} />;
  const near = path.match(/^\/app\/near\/(n[0-9a-f]{16})$/);
  if (near) return <NearDetail id={near[1]} />;
  const combo = path.match(/^\/app\/combo\/(c[0-9a-f]{16})$/);
  if (combo) return <ComboDetail id={combo[1]} />;
  if (path === "/app") return <AppHome />;
  if (path === "/app/activity") return <Activity />;
  if (path === "/wallet") return <WalletPage />;
  if (path === "/run-a-node") return <RunNode />;
  if (path === "/help") return <Help />;
  if (path === "/how-it-works") return <HowItWorks />;
  if (path === "/safety") return <Safety />;
  if (path === "/privacy") return <Privacy />;
  if (path === "/ramp") return <Ramp />;
  if (path === "/inspect") return <App />;
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DaemonProvider>
      <RoutesProvider>
        <NearProvider>
          <Root />
        </NearProvider>
      </RoutesProvider>
    </DaemonProvider>
  </StrictMode>,
);
