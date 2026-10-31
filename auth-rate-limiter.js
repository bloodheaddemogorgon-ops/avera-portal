"use strict";

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_ACCOUNT_FAILURE_LIMIT = 10;
const DEFAULT_IP_FAILURE_LIMIT = 40;
const DEFAULT_MAX_BUCKETS = 10000;

function createAuthRateLimiter({
  accountFailureLimit = DEFAULT_ACCOUNT_FAILURE_LIMIT,
  ipFailureLimit = DEFAULT_IP_FAILURE_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  maxBuckets = DEFAULT_MAX_BUCKETS,
} = {}) {
  for (const [name, value] of Object.entries({
    accountFailureLimit,
    ipFailureLimit,
    windowMs,
    maxBuckets,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer.`);
    }
  }
  if (maxBuckets < 2) throw new RangeError("maxBuckets must be at least 2.");

  const failures = new Map();

  function getKeys(ipAddress, email) {
    const address = typeof ipAddress === "string" && ipAddress ? ipAddress : "unknown";
    const normalizedEmail = typeof email === "string"
      ? email.trim().toLowerCase().slice(0, 320)
      : "";
    return [
      { key: `ip:${address}`, limit: ipFailureLimit },
      ...(normalizedEmail ? [{ key: `account:${normalizedEmail}`, limit: accountFailureLimit }] : []),
    ];
  }

  function getBucket(key, now, create) {
    let bucket = failures.get(key);
    if (bucket && bucket.expiresAt <= now) {
      failures.delete(key);
      bucket = null;
    }
    if (!bucket && create) {
      if (failures.size >= maxBuckets) {
        for (const [existingKey, existingBucket] of failures) {
          if (existingBucket.expiresAt <= now) failures.delete(existingKey);
        }
        if (failures.size >= maxBuckets) {
          failures.delete(failures.keys().next().value);
        }
      }
      bucket = { attempts: [], expiresAt: now + windowMs };
      failures.set(key, bucket);
    } else if (bucket) {
      failures.delete(key);
      failures.set(key, bucket);
    }
    return bucket;
  }

  function pruneAttempts(bucket, now) {
    while (bucket.attempts.length && now - bucket.attempts[0].at >= windowMs) {
      bucket.attempts.shift();
    }
  }

  function getRetryAfterSeconds(ipAddress, email, now = Date.now()) {
    let retryAfterMs = 0;
    for (const { key, limit } of getKeys(ipAddress, email)) {
      const bucket = getBucket(key, now, false);
      if (!bucket) continue;
      pruneAttempts(bucket, now);
      if (bucket.attempts.length >= limit) {
        retryAfterMs = Math.max(
          retryAfterMs,
          windowMs - (now - bucket.attempts[0].at),
        );
      }
    }
    return Math.ceil(retryAfterMs / 1000);
  }

  function reserveAttempt(ipAddress, email, now = Date.now()) {
    const retryAfterSeconds = getRetryAfterSeconds(ipAddress, email, now);
    if (retryAfterSeconds) {
      return { retryAfterSeconds, cancel() {} };
    }

    const reservations = [];
    for (const { key } of getKeys(ipAddress, email)) {
      const bucket = getBucket(key, now, true);
      pruneAttempts(bucket, now);
      const attempt = { at: now };
      bucket.attempts.push(attempt);
      bucket.expiresAt = Math.max(bucket.expiresAt, attempt.at + windowMs);
      reservations.push({ key, bucket, attempt });
    }

    return {
      retryAfterSeconds: 0,
      cancel() {
        for (const { key, bucket, attempt } of reservations) {
          const index = bucket.attempts.indexOf(attempt);
          if (index < 0) continue;
          bucket.attempts.splice(index, 1);
          if (!bucket.attempts.length) {
            if (failures.get(key) === bucket) failures.delete(key);
          } else {
            bucket.expiresAt = bucket.attempts.reduce(
              (expiresAt, { at }) => Math.max(expiresAt, at + windowMs),
              0,
            );
          }
        }
      },
    };
  }

  function clearAccount(email) {
    const normalizedEmail = typeof email === "string"
      ? email.trim().toLowerCase().slice(0, 320)
      : "";
    if (normalizedEmail) failures.delete(`account:${normalizedEmail}`);
  }

  return Object.freeze({ getRetryAfterSeconds, reserveAttempt, clearAccount });
}

module.exports = { createAuthRateLimiter };
