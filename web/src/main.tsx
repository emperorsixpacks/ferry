import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/spectral/latin-400-italic.css";
import "@fontsource/spectral/latin-600-italic.css";
import "@fontsource/public-sans/latin-400.css";
import "@fontsource/public-sans/latin-500.css";
import "@fontsource/public-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import App from "./App";
import { usePath } from "./router";
import SwapApp from "./swap/SwapApp";
import HowItWorks from "./explain/HowItWorks";

// `/` is the swap app for this party, `/how-it-works` the plain-language explainer and
// `/inspect` the live two-party protocol view for developers.
function Root() {
  const path = usePath().replace(/\/+$/, "");
  if (path === "/how-it-works") return <HowItWorks />;
  if (path === "/inspect") return <App />;
  return <SwapApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
