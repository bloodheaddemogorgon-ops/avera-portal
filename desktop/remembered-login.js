"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function isSecureStorageAvailable(safeStorage, platform) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (platform !== "linux") return true;
  return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]
    .includes(safeStorage.getSelectedStorageBackend());
}

function isValidCredentials(value) {
  return value
    && typeof value.email === "string"
    && value.email.length > 0
    && value.email.length <= 254
    && typeof value.password === "string"
    && value.password.length > 0
    && value.password.length <= 256;
}

function createRememberedLoginStore({
  safeStorage,
  filePath,
  platform = process.platform,
  fileSystem = fs,
}) {
  if (!safeStorage || typeof filePath !== "string" || !filePath) {
    throw new TypeError("Secure storage and a file path are required.");
  }

  async function save(credentials) {
    if (!isValidCredentials(credentials)) {
      throw new TypeError("A valid email and password are required.");
    }
    if (!isSecureStorageAvailable(safeStorage, platform)) {
      return { saved: false, reason: "unavailable" };
    }

    const encrypted = safeStorage.encryptString(JSON.stringify({
      version: 1,
      email: credentials.email,
      password: credentials.password,
    }));
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fileSystem.writeFile(temporaryPath, encrypted.toString("base64"), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fileSystem.rename(temporaryPath, filePath);
    return { saved: true };
  }

  async function load() {
    if (!isSecureStorageAvailable(safeStorage, platform)) {
      return { credentials: null, reason: "unavailable" };
    }

    let encryptedText;
    try {
      encryptedText = await fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { credentials: null, reason: "missing" };
      throw error;
    }

    try {
      const record = JSON.parse(safeStorage.decryptString(Buffer.from(encryptedText, "base64")));
      if (record.version !== 1 || !isValidCredentials(record)) {
        throw new Error("The remembered sign-in record is invalid.");
      }
      return {
        credentials: { email: record.email, password: record.password },
        reason: null,
      };
    } catch {
      await clear();
      return { credentials: null, reason: "invalid" };
    }
  }

  async function clear() {
    await fileSystem.rm(filePath, { force: true });
  }

  async function updatePassword(password) {
    const stored = await load();
    if (!stored.credentials) return { saved: false, reason: stored.reason };
    return save({ ...stored.credentials, password });
  }

  return { save, load, clear, updatePassword };
}

async function restoreRememberedLogin({ store, authenticate }) {
  const saved = await store.load();
  if (!saved.credentials) return { restored: false, reason: saved.reason };

  const result = await authenticate(saved.credentials);
  if (result.status === 401 || result.status === 403) {
    await store.clear();
    return { restored: false, reason: "invalid" };
  }
  if (!result.ok) return { restored: false, reason: "unavailable" };
  return { restored: true, reason: null };
}

module.exports = {
  createRememberedLoginStore,
  isSecureStorageAvailable,
  restoreRememberedLogin,
};
