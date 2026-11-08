"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
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

test("portal records are saved locally even when online storage settings are requested", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "portal-local-only-"));
  const databasePath = path.join(directory, "database.sqlite");
  let remoteCalls = 0;
  const backend = createServer({
    storageMode: "dual",
    postgresPool: { async query() { remoteCalls += 1; throw new Error("Online storage must not be used"); } },
    databasePath,
    migrationWorkbookPath: path.join(__dirname, "..", "grade5-portal-database-template.xlsx"),
  });
  const backendUrl = await listen(backend);
  context.after(async () => {
    await close(backend);
    await fs.rm(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${backendUrl}/api/health`);
  assert.deepEqual(await health.json(), { status: "ok", storage: "sqlite" });
  const registration = await fetch(`${backendUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Local Teacher",
      email: "local.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  assert.ok((await fs.stat(databasePath)).size > 0, "local SQLite file stores portal records");
  assert.equal(remoteCalls, 0, "no online database calls are made");
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
  const portals = ["teacher", "parents"].map((entry) =>
    createPortalFrontendServer({ entry, backendUrl }),
  );

  try {
    const portalOrigins = await Promise.all(portals.map(listen));
    assert.equal(new Set(portalOrigins).size, 2);

    for (const [index, entry] of ["teacher", "parents"].entries()) {
      const pageResponse = await fetch(portalOrigins[index]);
      const html = await pageResponse.text();
      const expectedEntry = entry === "teacher" ? "main" : entry;
      assert.equal(pageResponse.status, 200);
      assert.match(html, new RegExp(`<html lang="en" data-portal-entry="${expectedEntry}">`));
      assert.doesNotMatch(html, /portal-entry-links|portal-entry-link/);
      assert.doesNotMatch(html, /id="authAccountType"/);
      assert.match(html, /data-mode="up"/);
      assert.doesNotMatch(html, /data-mode="up" hidden/);
      const apiResponse = await fetch(`${portalOrigins[index]}/api/health`, {
        headers: { Cookie: `portal_session=${entry}` },
      });
      assert.equal(apiResponse.status, 200);
      assert.deepEqual(await apiResponse.json(), { status: "ok", storage: "sqlite" });
      assert.match(apiResponse.headers.get("set-cookie"), /portal_session=shared/);
    }

    const faviconResponse = await fetch(`${portalOrigins[0]}/favicon.png`);
    assert.equal(faviconResponse.status, 200);
    assert.match(faviconResponse.headers.get("content-type"), /^image\/png/);
    assert.ok((await faviconResponse.arrayBuffer()).byteLength > 0);

    assert.equal(apiRequests.length, 2);
    assert.deepEqual(apiRequests.map(({ url }) => url), [
      "/api/health",
      "/api/health",
    ]);
    assert.deepEqual(apiRequests.map(({ cookie }) => cookie), [
      "portal_session=teacher",
      "portal_session=parents",
    ]);
    assert.deepEqual(apiRequests.map(({ portalEntry }) => portalEntry), [
      "teacher",
      "parents",
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
    for (const [route, expected] of [["/", "main"], ["/parents", "parents"]]) {
      const html = await (await fetch(`${origin}${route}`)).text();
      assert.match(html, new RegExp(`data-portal-entry="${expected}"`));
      assert.doesNotMatch(html, /portal-entry-links|portal-entry-link/);
    }
    assert.equal((await fetch(`${origin}/nope`)).status, 404);
    assert.equal((await fetch(`${origin}/admin/extra`)).status, 404);
    assert.equal((await fetch(`${origin}/admin`)).status, 404);

    for (const route of ["/parents", "/"]) {
      await fetch(`${origin}/api/health`, {
        headers: {
          Referer: `${origin}${route}`,
          "X-Forwarded-For": "203.0.113.9, 198.51.100.7",
          "X-Forwarded-Proto": "https",
        },
      });
    }
    assert.deepEqual(apiRequests.map(({ entry }) => entry), ["parents", "teacher"]);
    assert.equal(apiRequests[0].forwardedFor, "198.51.100.7");
    assert.equal(apiRequests[0].forwardedProto, "https");
  } finally {
    await Promise.all([portal, backend].map(close));
  }
});

test("teacher-only desktop server serves only the teacher portal", async () => {
  const portal = createServer({ teacherOnly: true });
  const origin = await listen(portal);

  try {
    const teacherResponse = await fetch(origin);
    const teacherHtml = await teacherResponse.text();
    assert.equal(teacherResponse.status, 200);
    assert.match(teacherHtml, /data-portal-entry="main"/);
    assert.doesNotMatch(teacherHtml, /class="portal-entry-link"/);

    for (const route of ["/parents", "/parents.html", "/admin", "/admin.html"]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 404, `${route} should not be served by the desktop app`);
    }
  } finally {
    await close(portal);
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
