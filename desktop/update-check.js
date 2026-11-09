"use strict";

const MAX_RETRIES = 2;

function isRetryableUpdateError(error) {
  const statusCode = error?.statusCode;
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

async function checkForUpdatesWithRetry(checkForUpdates, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await checkForUpdates();
    } catch (error) {
      if (!isRetryableUpdateError(error) || attempt >= MAX_RETRIES) throw error;
      await wait(1000 * (2 ** attempt));
    }
  }
}

function getUpdateCheckErrorMessage(error) {
  const statusCode = error?.statusCode;
  if (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return "GitHub is temporarily unavailable while checking for updates. Please try again in a moment.";
  }
  if (/releases\.atom|No published versions|Cannot find latest\.yml|\b404\b/i.test(String(error?.message || ""))) {
    return "The update source is unavailable. The GitHub repository bloodheaddemogorgon-ops/avera-portal must be public and have a published release containing latest.yml.";
  }
  return null;
}

module.exports = { checkForUpdatesWithRetry, getUpdateCheckErrorMessage };
