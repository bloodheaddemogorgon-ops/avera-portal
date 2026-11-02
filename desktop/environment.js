"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

function normalizeDatabaseUrl(value) {
  const text = typeof value === "string" ? value.trim() : "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("Paste the full Neon connection string (it starts with postgresql://).");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || text.length > 2048 || /[\r\n]/.test(text)) {
    throw new Error("Paste the full Neon connection string (it starts with postgresql://).");
  }
  return text;
}

function saveOnlineDatabaseSettings(userDataPath, databaseUrl) {
  const url = normalizeDatabaseUrl(databaseUrl);
  const envPath = path.join(userDataPath, ".env");
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*(SUPABASE_DB_URL|PORTAL_STORAGE_MODE)\s*=/.test(line));
  kept.push("PORTAL_STORAGE_MODE=dual", `SUPABASE_DB_URL=${JSON.stringify(url)}`);
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(envPath, `${kept.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function readEmbeddedDatabaseUrl() {
  try {
    const embedded = JSON.parse(fs.readFileSync(path.join(__dirname, "embedded-online.json"), "utf8"));
    return normalizeDatabaseUrl(embedded.databaseUrl);
  } catch {
    return null;
  }
}

function loadDesktopEnvironment(userDataPath) {
  const envPath = path.join(userDataPath, ".env");
  // Private installers ship with the shared online database so every device connects without setup.
  const embeddedUrl = readEmbeddedDatabaseUrl();
  if (embeddedUrl) saveOnlineDatabaseSettings(userDataPath, embeddedUrl);
  if (!fs.existsSync(envPath)) return false;

  const result = dotenv.config({ path: envPath });
  if (result.error) {
    throw new Error(`Could not load desktop settings from ${envPath}.`, { cause: result.error });
  }
  return true;
}

module.exports = { loadDesktopEnvironment, normalizeDatabaseUrl, saveOnlineDatabaseSettings };
