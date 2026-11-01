"use strict";

// Single-service hosting: the API listens on loopback only; one public server hosts the
// teacher (/), parents (/parents) and admin (/admin) pages and proxies /api to the API.
const { spawn } = require("node:child_process");
const path = require("node:path");

const API_PORT = "3003";
const publicPort = process.env.PORT || "10000";
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill();
}

function start(script, args, env, keepSecrets) {
  const childEnv = { ...process.env, ...env };
  if (!keepSecrets) {
    delete childEnv.ADMIN_EMAIL;
    delete childEnv.ADMIN_PASSWORD;
    delete childEnv.SUPABASE_DB_URL;
  }
  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
    env: childEnv,
    stdio: "inherit",
  });
  children.push(child);
  child.once("exit", (code) => {
    if (!stopping) {
      console.error(`${script} stopped unexpectedly (exit code ${code}).`);
      stop(code || 1);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
start("server.js", ["--api"], { PORT: API_PORT, HOST: "127.0.0.1" }, true);
start("portal-frontend.js", ["all"], {
  PORT: publicPort,
  HOST: "0.0.0.0",
  PORTAL_API_URL: `http://127.0.0.1:${API_PORT}`,
  PORTAL_TRUST_PROXY: "true",
}, false);
