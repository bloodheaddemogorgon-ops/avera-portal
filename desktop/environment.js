"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

function loadDesktopEnvironment(userDataPath) {
  const envPath = path.join(userDataPath, ".env");
  if (!fs.existsSync(envPath)) return false;

  const result = dotenv.config({ path: envPath });
  if (result.error) {
    throw new Error(`Could not load desktop settings from ${envPath}.`, { cause: result.error });
  }
  return true;
}

module.exports = { loadDesktopEnvironment };
