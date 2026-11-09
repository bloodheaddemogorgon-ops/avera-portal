"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { checkForUpdatesWithRetry, getUpdateCheckErrorMessage } = require("../desktop/update-check");

test("retries transient update errors and returns a successful check", async () => {
  const delays = [];
  let attempts = 0;
  const result = await checkForUpdatesWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("Gateway timeout");
      error.statusCode = 504;
      throw error;
    }
    return { isUpdateAvailable: true };
  }, async (milliseconds) => delays.push(milliseconds));

  assert.deepEqual(result, { isUpdateAvailable: true });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test("does not retry non-transient update errors", async () => {
  const error = new Error("Not found");
  error.statusCode = 404;
  let attempts = 0;

  await assert.rejects(checkForUpdatesWithRetry(async () => {
    attempts += 1;
    throw error;
  }, async () => assert.fail("A permanent error must not be retried.")), error);

  assert.equal(attempts, 1);
});

test("reports exhausted GitHub gateway errors without exposing response HTML", () => {
  const error = new Error("504 Gateway Time-out\n<html>error</html>");
  error.statusCode = 504;

  assert.equal(
    getUpdateCheckErrorMessage(error),
    "GitHub is temporarily unavailable while checking for updates. Please try again in a moment.",
  );
});
