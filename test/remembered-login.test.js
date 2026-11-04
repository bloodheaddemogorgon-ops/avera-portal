"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createRememberedLoginStore,
  isSecureStorageAvailable,
  restoreRememberedLogin,
} = require("../desktop/remembered-login");

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => {
      const text = value.toString();
      if (!text.startsWith("encrypted:")) throw new Error("Invalid ciphertext.");
      return text.slice("encrypted:".length);
    },
  };
}

async function createStore(t, safeStorage = createSafeStorage()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gracedesk-remembered-login-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    safeStorage,
    store: createRememberedLoginStore({
      safeStorage,
      filePath: path.join(directory, "remembered-login.enc"),
      platform: "win32",
    }),
  };
}

const credentials = { email: "teacher@example.com", password: "correct horse battery staple" };

test("first sign-in can be saved securely without writing credentials as plain text", async (t) => {
  const { directory, store } = await createStore(t);

  assert.deepEqual(await store.load(), { credentials: null, reason: "missing" });
  assert.deepEqual(await store.save(credentials), { saved: true });

  const encryptedFile = await fs.readFile(path.join(directory, "remembered-login.enc"), "utf8");
  assert.doesNotMatch(encryptedFile, /teacher@example\.com|correct horse battery staple/);
  assert.deepEqual(await store.load(), { credentials, reason: null });
});

test("reopening with a valid saved session restores the account", async (t) => {
  const { store } = await createStore(t);
  await store.save(credentials);
  let authenticatedEmail = "";

  const result = await restoreRememberedLogin({
    store,
    authenticate: async (savedCredentials) => {
      authenticatedEmail = savedCredentials.email;
      return { ok: true, status: 200 };
    },
  });

  assert.equal(authenticatedEmail, credentials.email);
  assert.deepEqual(result, { restored: true, reason: null });
});

test("a new store instance restores a saved account after a device restart", async (t) => {
  const { directory, safeStorage } = await createStore(t);
  const beforeRestart = createRememberedLoginStore({
    safeStorage,
    filePath: path.join(directory, "remembered-login.enc"),
    platform: "win32",
  });
  await beforeRestart.save(credentials);

  const afterRestart = createRememberedLoginStore({
    safeStorage,
    filePath: path.join(directory, "remembered-login.enc"),
    platform: "win32",
  });
  const result = await restoreRememberedLogin({
    store: afterRestart,
    authenticate: async (savedCredentials) => ({
      ok: savedCredentials.password === credentials.password,
      status: savedCredentials.password === credentials.password ? 200 : 401,
    }),
  });

  assert.deepEqual(result, { restored: true, reason: null });
});

test("sign-out clears the saved account", async (t) => {
  const { directory, store } = await createStore(t);
  await store.save(credentials);

  await store.clear();

  assert.deepEqual(await store.load(), { credentials: null, reason: "missing" });
  await assert.rejects(fs.access(path.join(directory, "remembered-login.enc")), { code: "ENOENT" });
  let attemptedAuthentication = false;
  const result = await restoreRememberedLogin({
    store,
    authenticate: async () => {
      attemptedAuthentication = true;
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(result, { restored: false, reason: "missing" });
  assert.equal(attemptedAuthentication, false);
});

test("expired or invalid credentials fall back and are removed", async (t) => {
  const { store } = await createStore(t);
  await store.save(credentials);

  const result = await restoreRememberedLogin({
    store,
    authenticate: async () => ({ ok: false, status: 401 }),
  });

  assert.deepEqual(result, { restored: false, reason: "invalid" });
  assert.deepEqual(await store.load(), { credentials: null, reason: "missing" });
});

test("missing saved credentials fall back without attempting authentication", async (t) => {
  const { store } = await createStore(t);
  let attemptedAuthentication = false;

  const result = await restoreRememberedLogin({
    store,
    authenticate: async () => {
      attemptedAuthentication = true;
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(result, { restored: false, reason: "missing" });
  assert.equal(attemptedAuthentication, false);
});

test("transient restore failures keep credentials for a later retry", async (t) => {
  const { store } = await createStore(t);
  await store.save(credentials);

  const result = await restoreRememberedLogin({
    store,
    authenticate: async () => ({ ok: false, status: 503 }),
  });

  assert.deepEqual(result, { restored: false, reason: "unavailable" });
  assert.deepEqual((await store.load()).credentials, credentials);
});

test("refuses insecure Linux fallback storage", async (t) => {
  const { directory } = await createStore(t, {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
  });
  const store = createRememberedLoginStore({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
    filePath: path.join(directory, "remembered-login.enc"),
    platform: "linux",
  });

  assert.equal(isSecureStorageAvailable({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "basic_text",
  }, "linux"), false);
  assert.deepEqual(await store.save(credentials), { saved: false, reason: "unavailable" });
  assert.deepEqual(await store.load(), { credentials: null, reason: "unavailable" });
});
