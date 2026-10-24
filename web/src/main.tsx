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

// `/` is the swap app for this party; `/how-it-works` is the two-party protocol view.
function Root() {
  const path = usePath();
  return path.replace(/\/+$/, "") === "/how-it-works" ? <App /> : <SwapApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
