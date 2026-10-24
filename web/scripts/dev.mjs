// `pnpm dev`: runs the mock daemons and the Vite UI together. Ctrl-C stops both.
// Point the UI at real daemons instead with `FERRY_Z_URL=… FERRY_B_URL=… pnpm dev:ui`.
import { spawn } from "node:child_process";

const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { stdio: "inherit", env: process.env }),
  spawn("pnpm", ["exec", "vite"], { stdio: "inherit", env: process.env }),
];

const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
