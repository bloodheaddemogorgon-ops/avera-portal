"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { transformSync } = require("next/dist/build/swc");

const projectRoot = path.join(__dirname, "..");

function loadTypeScriptModule(filePath, dependencies = {}) {
  const source = fs.readFileSync(filePath, "utf8");
  const { code } = transformSync(source, {
    filename: filePath,
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const loadedModule = { exports: {} };
  const loadDependency = (specifier) => (
    Object.prototype.hasOwnProperty.call(dependencies, specifier)
      ? dependencies[specifier]
      : require(specifier)
  );
  new Function("require", "module", "exports", code)(
    loadDependency,
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

async function withProductionHarness({ cookieValue, sessionResponse }, run) {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousFetch = global.fetch;
  const requests = [];
  process.env.NODE_ENV = "production";
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify(sessionResponse), {
      status: sessionResponse.status || 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const portalApi = loadTypeScriptModule(path.join(projectRoot, "lib", "portal-api.ts"));
    const currentUser = loadTypeScriptModule(
      path.join(projectRoot, "lib", "current-user.ts"),
      {
        "next/headers": {
          cookies: async () => ({
            get: (name) => (name === "grade5_session_teacher" && cookieValue
              ? { name, value: cookieValue }
              : undefined),
          }),
        },
        "@/lib/portal-api": portalApi,
      },
    );
    await run({ currentUser, portalApi, requests });
  } finally {
    global.fetch = previousFetch;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
}

test("production classroom requests resolve and forward an authenticated teacher session", async () => {
  await withProductionHarness({
    cookieValue: "session-token",
    sessionResponse: { user: { userId: "teacher-42", role: "teacher" } },
  }, async ({ currentUser, portalApi, requests }) => {
    const identity = await currentUser.getCurrentUser();
    assert.deepEqual(identity, {
      userId: "teacher-42",
      sessionCookie: "grade5_session_teacher=session-token",
    });

    await portalApi.portalRequest("/api/classrooms", identity);
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const headers = new Headers(request.options.headers);
      assert.equal(headers.get("cookie"), "grade5_session_teacher=session-token");
      assert.equal(headers.get("x-portal-entry"), "teacher");
      assert.equal(headers.has("x-dev-user-id"), false);
    }
    assert.match(requests[0].url, /\/api\/auth\/session$/);
    assert.match(requests[1].url, /\/api\/classrooms$/);
  });
});

test("production classroom identity rejects missing and non-teacher sessions", async () => {
  await withProductionHarness({
    sessionResponse: { user: { userId: "parent-42", role: "parent" } },
  }, async ({ currentUser, requests }) => {
    await assert.rejects(currentUser.getCurrentUser(), /Unauthorized/);
    assert.equal(requests.length, 0, "missing session cookies are rejected before contacting the API");
  });

  await withProductionHarness({
    cookieValue: "parent-session-token",
    sessionResponse: { user: { userId: "parent-42", role: "parent" } },
  }, async ({ currentUser, requests }) => {
    await assert.rejects(currentUser.getCurrentUser(), /Unauthorized/);
    assert.equal(requests.length, 1, "a parent session is verified but cannot access classroom actions");
  });
});
