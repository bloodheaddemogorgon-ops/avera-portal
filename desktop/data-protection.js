"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

async function fileIsUsable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size < 100) return false;
    const handle = await fs.open(filePath, "r");
    try {
      const header = Buffer.alloc(16);
      await handle.read(header, 0, header.length, 0);
      return header.toString("ascii") === "SQLite format 3\0";
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function copyUsableDatabase(source, destination) {
  if (!await fileIsUsable(source)) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}

async function createDatabaseBackup({ databasePath, backupDirectory, maximumBackups = 10 }) {
  if (!await fileIsUsable(databasePath)) return { created: false };
  await fs.mkdir(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const databaseName = path.basename(databasePath);
  const backupPath = path.join(backupDirectory, `${databaseName}.${timestamp}`);
  const tempPath = `${backupPath}.tmp`;
  await fs.copyFile(databasePath, tempPath);
  await fs.rename(tempPath, backupPath);

  const prefix = `${databaseName}.`;
  const entries = await fs.readdir(backupDirectory);
  const backups = entries
    .filter((name) => name.startsWith(prefix) && name !== databaseName)
    .map((name) => path.join(backupDirectory, name));
  const stats = await Promise.all(backups.map(async (file) => ({
    file,
    stat: await fs.stat(file).catch(() => null),
  })));
  const sorted = stats.filter((entry) => entry.stat?.isFile())
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  for (const old of sorted.slice(maximumBackups)) {
    await fs.unlink(old.file).catch(() => {});
  }
  return { created: true, backupPath };
}

async function restoreBestDatabase({ databasePath, backupDirectory, legacyDatabasePaths = [] }) {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  if (await fileIsUsable(databasePath)) return { restored: false, source: databasePath };

  for (const legacyPath of legacyDatabasePaths) {
    if (await copyUsableDatabase(legacyPath, databasePath)) {
      return { restored: true, source: legacyPath };
    }
  }

  try {
    const databaseName = path.basename(databasePath);
    const entries = await fs.readdir(backupDirectory);
    const backups = entries
      .filter((name) => name.startsWith(`${databaseName}.`))
      .map((name) => path.join(backupDirectory, name));
    const stats = await Promise.all(backups.map(async (file) => ({
      file,
      stat: await fs.stat(file).catch(() => null),
    })));
    const newest = stats.filter((entry) => entry.stat?.isFile())
      .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
    if (newest && await copyUsableDatabase(newest.file, databasePath)) {
      return { restored: true, source: newest.file };
    }
  } catch {}
  return { restored: false, source: null };
}

async function listDatabaseBackups({ databasePath, backupDirectory }) {
  try {
    const databaseName = path.basename(databasePath);
    const entries = await fs.readdir(backupDirectory);
    const backups = await Promise.all(entries
      .filter((name) => name.startsWith(`${databaseName}.`))
      .map(async (name) => {
        const filePath = path.join(backupDirectory, name);
        const stat = await fs.stat(filePath).catch(() => null);
        return stat?.isFile() ? { name, filePath, size: stat.size, createdAt: stat.mtime.toISOString() } : null;
      }));
    return backups.filter(Boolean).sort((left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [];
  }
}

module.exports = {
  fileIsUsable,
  copyUsableDatabase,
  createDatabaseBackup,
  restoreBestDatabase,
  listDatabaseBackups,
};
