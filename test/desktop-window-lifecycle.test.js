"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { focusOrCreateWindow } = require("../desktop/window-lifecycle");

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
