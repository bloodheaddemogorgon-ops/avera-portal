"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { focusOrCreateWindow, loadAndShowWindow } = require("../desktop/window-lifecycle");

test("shows the window on first render before URL loading finishes", async () => {
  const calls = [];
  let readyToShow;
  let finishLoading;
  const window = {
    once: (event, callback) => {
      assert.equal(event, "ready-to-show");
      readyToShow = callback;
    },
    loadURL: (url) => {
      calls.push(`load:${url}`);
      return new Promise((resolve) => {
        finishLoading = resolve;
      });
    },
    isDestroyed: () => false,
    isVisible: () => calls.includes("show"),
    show: () => calls.push("show"),
  };

  const loading = loadAndShowWindow(window, "http://localhost");
  readyToShow();

  assert.deepEqual(calls, ["load:http://localhost", "show"]);
  finishLoading();
  assert.equal(await loading, window);
  assert.deepEqual(calls, ["load:http://localhost", "show"]);
});

test("shows the window after loading if ready-to-show was missed", async () => {
  const calls = [];
  const window = {
    once: () => {},
    loadURL: async () => {},
    isDestroyed: () => false,
    isVisible: () => calls.includes("show"),
    show: () => calls.push("show"),
  };

  await loadAndShowWindow(window, "http://localhost");

  assert.deepEqual(calls, ["show"]);
});

test("removes the ready-to-show listener when URL loading fails", async () => {
  const calls = [];
  const error = new Error("load failed");
  const window = {
    once: (event, callback) => calls.push(["once", event, callback]),
    loadURL: async () => {
      throw error;
    },
    removeListener: (event, callback) => calls.push(["removeListener", event, callback]),
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => calls.push(["show"]),
  };

  await assert.rejects(loadAndShowWindow(window, "http://localhost"), error);

  assert.equal(calls[0][0], "once");
  assert.deepEqual(calls[1], ["removeListener", calls[0][1], calls[0][2]]);
});

test("recreates a portal window after the previous window has closed", async () => {
  const replacementWindow = {};
  let createCount = 0;

  const result = await focusOrCreateWindow(null, async () => {
    createCount += 1;
    return replacementWindow;
  });

  assert.equal(result, replacementWindow);
  assert.equal(createCount, 1);
});

test("restores and focuses the renderer when reopening a minimized window", async () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("window-focus"),
    webContents: { focus: () => calls.push("renderer-focus") },
  };

  const result = await focusOrCreateWindow(window, () => {
    assert.fail("An existing window should be reused.");
  });

  assert.equal(result, window);
  assert.deepEqual(calls, ["restore", "show", "window-focus", "renderer-focus"]);
});

test("recreates a destroyed portal window", async () => {
  const replacementWindow = {};
  const closedWindow = {
    isDestroyed: () => true,
  };

  const result = await focusOrCreateWindow(closedWindow, async () => replacementWindow);

  assert.equal(result, replacementWindow);
});
