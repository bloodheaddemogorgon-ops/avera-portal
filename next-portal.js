"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("Usage: node next-portal.js <dev|start>");
  process.exitCode = 1;
} else {
  const apiPort = Number(process.env.PORTAL_API_PORT || 3003);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    console.error("PORTAL_API_PORT must be an integer between 1 and 65535.");
    process.exitCode = 1;
  } else {
    const nextCli = require.resolve("next/dist/bin/next");
    const apiServer = spawn(
      process.execPath,
      [path.join(__dirname, "server.js"), "--api"],
      {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(apiPort),
          // Matches the mocked user in lib/current-user.ts; development only.
          ...(mode === "dev" ? { PORTAL_DEV_USER_ID: "dev-user-123" } : {}),
        },
        stdio: "inherit",
      },
    );
    const nextServer = spawn(
      process.execPath,
      [nextCli, mode, "--hostname", "127.0.0.1"],
      {
        env: {
          ...process.env,
          PORTAL_API_PORT: String(apiPort),
        },
        stdio: "inherit",
      },
    );
    const children = [apiServer, nextServer];
    let stopping = false;

    function stop(exitCode) {
      if (stopping) return;
      stopping = true;
      process.exitCode = exitCode;
      for (const child of children) {
        if (child.exitCode === null && !child.killed) child.kill();
      }
    }

    for (const child of children) {
      child.once("error", (error) => {
        console.error("Could not start the Next portal service:", error.message);
        stop(1);
      });
      child.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(`A Next portal service stopped unexpectedly (${signal || `exit code ${code}`}).`);
          stop(code || 1);
        }
      });
    }

    process.once("SIGINT", () => stop(0));
    process.once("SIGTERM", () => stop(0));
  }
}
