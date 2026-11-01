"use strict";

const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { loadDesktopEnvironment } = require("../desktop/environment");
const { createPortalFrontendServer } = require("../portal-frontend");
const { createServer } = require("../server");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function createPostgresPool() {
  let available = true;
  let remoteState = null;
  let revision = 0;
  const query = async (text, values = []) => {
    if (!available) {
      const error = new Error("Database unavailable");
      error.code = "ECONNREFUSED";
      throw error;
    }
    const sql = text.trim().replace(/\s+/g, " ").toLowerCase();
    if (sql.startsWith("select workbook_state, revision from portal_state")) {
      return {
        rows: remoteState ? [{ workbook_state: remoteState, revision }] : [],
        rowCount: remoteState ? 1 : 0,
      };
    }
    if (sql.startsWith("insert into portal_state")) {
      if (!remoteState) {
        remoteState = Buffer.from(values[0]);
        revision = 1;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("update portal_state")) {
      remoteState = Buffer.from(values[0]);
      revision += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("select id from portal_state")) {
      return { rows: remoteState ? [{ id: 1 }] : [], rowCount: remoteState ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: {
      query,
      async connect() {
        return { query, release() {} };
      },
      async end() {},
    },
    setAvailable(value) {
      available = value;
    },
    advanceRemoteRevision() {
      revision += 1;
    },
    get revision() {
      return revision;
    },
  };
}

async function waitFor(assertion, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await delay(20);
  }
  assert.ok(await assertion(), "timed out waiting for background synchronization");
}

test("desktop loads dual-storage settings from the per-user environment file", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-desktop-env-"));
  const previousMode = process.env.PORTAL_STORAGE_MODE;
  const previousDatabaseUrl = process.env.SUPABASE_DB_URL;
  delete process.env.PORTAL_STORAGE_MODE;
  delete process.env.SUPABASE_DB_URL;
  context.after(async () => {
    if (previousMode === undefined) delete process.env.PORTAL_STORAGE_MODE;
    else process.env.PORTAL_STORAGE_MODE = previousMode;
    if (previousDatabaseUrl === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = previousDatabaseUrl;
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal(loadDesktopEnvironment(directory), false);
  await fs.writeFile(
    path.join(directory, ".env"),
    "PORTAL_STORAGE_MODE=dual\nSUPABASE_DB_URL=postgresql://test:test@localhost/test\n",
  );
  assert.equal(loadDesktopEnvironment(directory), true);
  assert.equal(process.env.PORTAL_STORAGE_MODE, "dual");
  assert.equal(process.env.SUPABASE_DB_URL, "postgresql://test:test@localhost/test");
});

test("separate portal frontends serve distinct entries and proxy to one API", async () => {
  const apiRequests = [];
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    apiRequests.push({
      method: request.method,
      url: request.url,
      cookie: request.headers.cookie,
      portalEntry: request.headers["x-portal-entry"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("Set-Cookie", "portal_session=shared; Path=/; HttpOnly; SameSite=Strict");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", storage: "sqlite" }));
  });
  const backendUrl = await listen(backend);
  const portalUrls = {
    teacher: "http://teacher.example.test",
    parents: "http://parents.example.test",
    admin: "http://admin.example.test",
  };
  const portals = ["teacher", "parents", "admin"].map((entry) =>
    createPortalFrontendServer({ entry, backendUrl, portalUrls }),
  );

  try {
    const portalOrigins = await Promise.all(portals.map(listen));
    assert.equal(new Set(portalOrigins).size, 3);

    for (const [index, entry] of ["teacher", "parents", "admin"].entries()) {
      const pageResponse = await fetch(portalOrigins[index]);
      const html = await pageResponse.text();
      const expectedEntry = entry === "teacher" ? "main" : entry;
      assert.equal(pageResponse.status, 200);
      assert.match(html, new RegExp(`<html lang="en" data-portal-entry="${expectedEntry}">`));
      assert.doesNotMatch(html, /id="authAccountType"/);
      assert.match(html, /data-mode="up"/);
      if (entry === "admin") {
        assert.match(html, /data-mode="up" hidden/);
      } else {
        assert.doesNotMatch(html, /data-mode="up" hidden/);
      }
      assert.ok(html.includes(`href="${portalUrls.teacher}"`));
      assert.ok(html.includes(`href="${portalUrls.parents}"`));
      assert.ok(html.includes(`href="${portalUrls.admin}"`));

      const apiResponse = await fetch(`${portalOrigins[index]}/api/health`, {
        headers: { Cookie: `portal_session=${entry}` },
      });
      assert.equal(apiResponse.status, 200);
      assert.deepEqual(await apiResponse.json(), { status: "ok", storage: "sqlite" });
      assert.match(apiResponse.headers.get("set-cookie"), /portal_session=shared/);
    }

    assert.equal(apiRequests.length, 3);
    assert.deepEqual(apiRequests.map(({ url }) => url), [
      "/api/health",
      "/api/health",
      "/api/health",
    ]);
    assert.deepEqual(apiRequests.map(({ cookie }) => cookie), [
      "portal_session=teacher",
      "portal_session=parents",
      "portal_session=admin",
    ]);
    assert.deepEqual(apiRequests.map(({ portalEntry }) => portalEntry), [
      "teacher",
      "parents",
      "admin",
    ]);
  } finally {
    await Promise.all([...portals, backend].map(close));
  }
});

test("combined portal server routes pages and API entry by path and referer", async () => {
  const apiRequests = [];
  const backend = http.createServer((request, response) => {
    apiRequests.push({
      entry: request.headers["x-portal-entry"],
      forwardedFor: request.headers["x-forwarded-for"],
      forwardedProto: request.headers["x-forwarded-proto"],
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  const backendUrl = await listen(backend);
  const portal = createPortalFrontendServer({ entry: "all", backendUrl, trustProxy: true });
  try {
    const origin = await listen(portal);
    for (const [route, expected] of [["/", "main"], ["/parents", "parents"], ["/admin", "admin"]]) {
      const html = await (await fetch(`${origin}${route}`)).text();
      assert.match(html, new RegExp(`data-portal-entry="${expected}"`));
    }
    assert.equal((await fetch(`${origin}/nope`)).status, 404);
    assert.equal((await fetch(`${origin}/admin/extra`)).status, 404);

    for (const route of ["/parents", "/admin", "/"]) {
      await fetch(`${origin}/api/health`, {
        headers: {
          Referer: `${origin}${route}`,
          "X-Forwarded-For": "203.0.113.9, 198.51.100.7",
          "X-Forwarded-Proto": "https",
        },
      });
    }
    assert.deepEqual(apiRequests.map(({ entry }) => entry), ["parents", "admin", "teacher"]);
    assert.equal(apiRequests[0].forwardedFor, "198.51.100.7");
    assert.equal(apiRequests[0].forwardedProto, "https");
  } finally {
    await Promise.all([portal, backend].map(close));
  }
});

test("API-only backend does not serve portal pages or static assets", async () => {
  const backend = createServer({ apiOnly: true });
  const backendUrl = await listen(backend);

  try {
    for (const path of ["/", "/parents", "/icon.png"]) {
      const response = await fetch(`${backendUrl}${path}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Page not found." });
    }
  } finally {
    await close(backend);
  }
});

test("shared API keeps portal sessions isolated across local ports", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-session-isolation-"));
  const backend = createServer({
    databasePath: path.join(directory, "database.sqlite"),
    migrationWorkbookPath: path.join(__dirname, "..", "grade5-portal-database-template.xlsx"),
  });
  const backendUrl = await listen(backend);
  context.after(async () => {
    await close(backend);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const registration = await fetch(`${backendUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Portal-Entry": "teacher",
    },
    body: JSON.stringify({
      name: "Portal Session Teacher",
      email: "portal.session.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  const teacherCookie = registration.headers.get("set-cookie").split(";")[0];
  assert.match(teacherCookie, /^grade5_session_teacher=/);

  const teacherSession = await fetch(`${backendUrl}/api/auth/session`, {
    headers: { "X-Portal-Entry": "teacher", Cookie: teacherCookie },
  });
  assert.equal(teacherSession.status, 200);

  const parentSession = await fetch(`${backendUrl}/api/auth/session`, {
    headers: { "X-Portal-Entry": "parents", Cookie: teacherCookie },
  });
  assert.equal(parentSession.status, 401);

  const logout = await fetch(`${backendUrl}/api/auth/logout`, {
    method: "POST",
    headers: { "X-Portal-Entry": "teacher", Cookie: teacherCookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /^grade5_session_teacher=;/);
});

test("dual storage accepts local writes offline and synchronizes them when online", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-dual-offline-"));
  const postgres = createPostgresPool();
  const backend = createServer({
    storageMode: "dual",
    postgresPool: postgres.pool,
    databasePath: path.join(directory, "database.sqlite"),
    migrationWorkbookPath: path.join(__dirname, "..", "grade5-portal-database-template.xlsx"),
    syncRetryIntervalMs: 25,
  });
  const backendUrl = await listen(backend);
  context.after(async () => {
    await close(backend);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const initialHealth = await fetch(`${backendUrl}/api/health`);
  assert.deepEqual(await initialHealth.json(), {
    status: "ok",
    storage: "dual",
    sync: "synced",
  });

  postgres.setAvailable(false);
  const registration = await fetch(`${backendUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Offline Sync Teacher",
      email: "offline.sync.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);

  await delay(150);
  const offlineHealth = await fetch(`${backendUrl}/api/health`);
  const offlineStatus = await offlineHealth.json();
  assert.equal(offlineHealth.status, 200);
  assert.equal(offlineStatus.storage, "dual");
  assert.equal(offlineStatus.sync, "offline");

  postgres.setAvailable(true);
  await waitFor(() => postgres.revision > 1);
  const syncedHealth = await fetch(`${backendUrl}/api/health`);
  assert.deepEqual(await syncedHealth.json(), {
    status: "ok",
    storage: "dual",
    sync: "synced",
  });
});

test("Synchronize Data Online endpoint pushes pending changes on demand", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-dual-manual-"));
  const postgres = createPostgresPool();
  const backend = createServer({
    storageMode: "dual",
    postgresPool: postgres.pool,
    databasePath: path.join(directory, "database.sqlite"),
    migrationWorkbookPath: path.join(__dirname, "..", "grade5-portal-database-template.xlsx"),
    syncRetryIntervalMs: 600000,
  });
  const backendUrl = await listen(backend);
  context.after(async () => {
    await close(backend);
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${backendUrl}/api/sync`, { method: "POST" })).status, 401);

  await fetch(`${backendUrl}/api/health`);
  postgres.setAvailable(false);
  const registration = await fetch(`${backendUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Manual Sync Teacher",
      email: "manual.sync.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  await delay(250);

  const unavailable = await fetch(`${backendUrl}/api/sync`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(unavailable.status, 503);

  postgres.setAvailable(true);
  const revisionBefore = postgres.revision;
  const synced = await fetch(`${backendUrl}/api/sync`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).state, "synced");
  assert.ok(postgres.revision > revisionBefore);
});

test("dual storage pauses on revision conflicts without overwriting the online copy", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-dual-conflict-"));
  const postgres = createPostgresPool();
  const backend = createServer({
    storageMode: "dual",
    postgresPool: postgres.pool,
    databasePath: path.join(directory, "database.sqlite"),
    migrationWorkbookPath: path.join(__dirname, "..", "grade5-portal-database-template.xlsx"),
    syncRetryIntervalMs: 25,
  });
  const backendUrl = await listen(backend);
  context.after(async () => {
    await close(backend);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const initialHealth = await fetch(`${backendUrl}/api/health`);
  assert.equal((await initialHealth.json()).sync, "synced");
  postgres.setAvailable(false);
  const registration = await fetch(`${backendUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Conflicting Sync Teacher",
      email: "conflicting.sync.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  postgres.advanceRemoteRevision();
  postgres.setAvailable(true);

  await waitFor(async () => {
    const response = await fetch(`${backendUrl}/api/health`);
    const status = await response.json();
    return status.sync === "conflict";
  });
  assert.equal(postgres.revision, 2);
  const localDatabase = new DatabaseSync(path.join(directory, "database.sqlite"));
  try {
    const savedConflict = localDatabase.prepare(
      "SELECT conflict, conflict_local_state, conflict_remote_state FROM portal_sync_state WHERE id = 1",
    ).get();
    assert.equal(savedConflict.conflict, 1);
    assert.ok(savedConflict.conflict_local_state.length > 0);
    assert.ok(savedConflict.conflict_remote_state.length > 0);
  } finally {
    localDatabase.close();
  }
});
