"use strict";

// Builds a PRIVATE installer that already contains the online database connection.
// Never upload the result to a public place (including GitHub releases).
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const root = path.join(__dirname, "..");
const embeddedPath = path.join(root, "desktop", "embedded-online.json");
const deviceEnvPath = path.join(process.env.APPDATA || "", "grade5-class-portal", ".env");

let databaseUrl = process.env.PORTAL_EMBED_DB_URL;
if (!databaseUrl && fs.existsSync(deviceEnvPath)) {
  databaseUrl = dotenv.parse(fs.readFileSync(deviceEnvPath)).SUPABASE_DB_URL;
}
if (!databaseUrl) {
  console.error("No online database found. Set PORTAL_EMBED_DB_URL or connect this device to Neon first.");
  process.exit(1);
}

fs.writeFileSync(embeddedPath, JSON.stringify({ databaseUrl }), { mode: 0o600 });
try {
  const result = spawnSync(
    "npx",
    ["electron-builder", "--win", "nsis", "--publish", "never", "-c.directories.output=release-private"],
    { cwd: root, stdio: "inherit", shell: true },
  );
  if (result.status !== 0) process.exit(result.status || 1);
} finally {
  fs.rmSync(embeddedPath, { force: true });
}
console.log("Private installer is in the release-private folder. Share it only with your own teachers.");
