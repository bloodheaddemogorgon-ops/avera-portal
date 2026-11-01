"use strict";

const dotenv = require("dotenv");
dotenv.config();
if (process.env.PORTAL_ADMIN_SECRET_FILE) {
  const secretEnv = dotenv.config({ path: process.env.PORTAL_ADMIN_SECRET_FILE });
  if (secretEnv.error) throw new Error("Could not load the configured administrator secret file.");
}

const { spawn } = require("node:child_process");
const path = require("node:path");

const configuredApiPort = Number(process.env.PORTAL_API_PORT || process.env.PORT || 3003);
const configuredPorts = {
  teacher: Number(process.env.PORTAL_TEACHER_PORT || 3004),
  parents: Number(process.env.PORTAL_PARENTS_PORT || 3005),
  admin: Number(process.env.PORTAL_ADMIN_PORT || 3006),
};
const tlsKeyPath = process.env.PORTAL_TLS_KEY;
const tlsCertPath = process.env.PORTAL_TLS_CERT;
const protocol = tlsKeyPath ? "https" : "http";
const publicHost = process.env.PORTAL_PUBLIC_HOST || "127.0.0.1";
const configuredHost = process.env.HOST || "127.0.0.1";
const formattedPublicHost = publicHost.includes(":") && !publicHost.startsWith("[")
  ? `[${publicHost}]`
  : publicHost;
const apiHost = process.env.PORTAL_API_HOST || (
  ["0.0.0.0", "::"].includes(configuredHost) ? publicHost : configuredHost
);
const formattedApiHost = apiHost.includes(":") && !apiHost.startsWith("[")
  ? `[${apiHost}]`
  : apiHost;
const apiUrl = process.env.PORTAL_API_URL
  || `${protocol}://${formattedApiHost}:${configuredApiPort}`;
const portalUrls = {
  teacher: process.env.PORTAL_TEACHER_URL || `${protocol}://${formattedPublicHost}:${configuredPorts.teacher}`,
  parents: process.env.PORTAL_PARENTS_URL || `${protocol}://${formattedPublicHost}:${configuredPorts.parents}`,
  admin: process.env.PORTAL_ADMIN_URL || `${protocol}://${formattedPublicHost}:${configuredPorts.admin}`,
};

const services = [
  {
    name: "shared API backend",
    script: "server.js",
    args: ["--api"],
    env: { PORT: String(configuredApiPort) },
  },
  ...Object.entries(configuredPorts).map(([entry, port]) => ({
    name: `${entry} portal frontend`,
    script: "portal-frontend.js",
    args: [entry],
    env: {
      [`PORTAL_${entry.toUpperCase()}_PORT`]: String(port),
      PORTAL_API_URL: apiUrl,
      PORTAL_TEACHER_URL: portalUrls.teacher,
      PORTAL_PARENTS_URL: portalUrls.parents,
      PORTAL_ADMIN_URL: portalUrls.admin,
    },
  })),
];
const children = [];
let shuttingDown = false;

function stopServices(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

function startService(service) {
  const childEnvironment = { ...process.env, ...service.env };
  if (service.name !== "shared API backend") {
    delete childEnvironment.ADMIN_EMAIL;
    delete childEnvironment.ADMIN_PASSWORD;
    delete childEnvironment.PORTAL_ADMIN_SECRET_FILE;
    delete childEnvironment.SUPABASE_DB_URL;
  }
  const child = spawn(
    process.execPath,
    [path.join(__dirname, service.script), ...service.args],
    {
      env: childEnvironment,
      stdio: "inherit",
    },
  );
  children.push(child);
  child.once("error", (error) => {
    console.error(`Could not start the ${service.name}:`, error.message);
    stopServices(1);
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `The ${service.name} stopped unexpectedly (${signal || `exit code ${code}`}).`,
      );
      stopServices(code || 1);
      return;
    }
    if (children.every((runningChild) => runningChild.exitCode !== null)) {
      if (process.exitCode === undefined) process.exitCode = 0;
    }
  });
}

if (!Number.isInteger(configuredApiPort) || configuredApiPort < 1 || configuredApiPort > 65535
  || Object.values(configuredPorts).some((port) =>
    !Number.isInteger(port) || port < 1 || port > 65535)) {
  console.error("The configured API and portal ports must be integers between 1 and 65535.");
  process.exitCode = 1;
} else if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
  console.error("PORTAL_TLS_KEY and PORTAL_TLS_CERT must be provided together.");
  process.exitCode = 1;
} else {
  process.on("SIGINT", () => stopServices(0));
  process.on("SIGTERM", () => stopServices(0));
  for (const service of services) startService(service);
}
