// `pnpm dev`: runs the mock daemons and the Vite UI together. Ctrl-C stops both.
// Point the UI at real daemons instead with `FERRY_Z_URL=… FERRY_B_URL=… pnpm dev:ui`.
// The maker list shows the mock's makers (mock/makers.mjs), both ways round, unless FERRY_MAKERS is
// set: the mock's Z (zoe) sells ZEC and its B (bram) buys it, so the swap card can flip.
// The mock also runs a router for private swaps (coin → shielded ZEC → coin) on MOCK_ROUTE_PORT
// (7140, as ferry-route; 0 for none), with partners for USDC on Base and LTC.
import { spawn } from "node:child_process";
import { mockMakersEnv } from "../mock/makers.mjs";

const bPort = Number(process.env.MOCK_B_PORT ?? 7102);
const zPort = Number(process.env.MOCK_Z_PORT ?? 7101);
const routePort = Number(process.env.MOCK_ROUTE_PORT ?? 7140);
const routes = routePort > 0;
const env = {
  ...process.env,
  FERRY_MAKERS: process.env.FERRY_MAKERS ?? mockMakersEnv(bPort, zPort, { routes }),
  MOCK_ROUTE_PORT: routes ? String(routePort) : "",
  ...(routes ? { FERRY_ROUTER_URL: process.env.FERRY_ROUTER_URL ?? `http://127.0.0.1:${routePort}` } : {}),
};

const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { stdio: "inherit", env }),
  spawn("pnpm", ["exec", "vite"], { stdio: "inherit", env }),
];

const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
