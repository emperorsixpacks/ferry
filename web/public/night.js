// The landing page (/) is dark: paint the page behind it dark before the app loads, so a first
// visit doesn't flash white. A file, not an inline script, because prod.mjs's CSP allows only
// scripts from 'self'. The landing resets it when you leave for the app's light pages.
if (location.pathname === "/") document.documentElement.style.background = "#070921";
