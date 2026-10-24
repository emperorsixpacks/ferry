// `pnpm dev`: runs the mock daemons and the Vite UI together. Ctrl-C stops both.
// Point the UI at real daemons instead with `FERRY_Z_URL=… FERRY_B_URL=… pnpm dev:ui`.
// The maker list shows the mock's makers (mock/makers.mjs), both ways round, unless FERRY_MAKERS is
// set: the mock's Z (zoe) sells ZEC and its B (bram) buys it, so the swap card can flip.
import { spawn } from "node:child_process";
import { mockMakersEnv } from "../mock/makers.mjs";

const bPort = Number(process.env.MOCK_B_PORT ?? 7102);
const zPort = Number(process.env.MOCK_Z_PORT ?? 7101);
const env = { ...process.env, FERRY_MAKERS: process.env.FERRY_MAKERS ?? mockMakersEnv(bPort, zPort) };

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
