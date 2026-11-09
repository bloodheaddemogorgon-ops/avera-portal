"use strict";

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createRememberedLoginStore } = require("./remembered-login");
const { checkForUpdatesWithRetry, getUpdateCheckErrorMessage } = require("./update-check");
const {
  createDatabaseBackup,
  restoreBestDatabase,
  listDatabaseBackups,
} = require("./data-protection");
const { focusOrCreateWindow, loadAndShowWindow } = require("./window-lifecycle");

// Use one stable data folder for accounts and academic records. It is never under
// the installed application directory, so package replacement cannot erase data.
const canonicalDataDirectory = path.join(app.getPath("appData"), "grade5-class-portal");
const databasePath = path.join(canonicalDataDirectory, "grade5-portal-database.sqlite");
const backupDirectory = path.join(canonicalDataDirectory, "backups");
const MAX_TEACHER_PHOTO_BYTES = 2 * 1024 * 1024;
const TEACHER_PHOTO_CONTENT_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const legacyDatabasePaths = [
  path.join(app.getPath("appData"), "AVeRA", "grade5-portal-database.sqlite"),
  path.join(app.getPath("userData"), "grade5-portal-database.sqlite"),
];

let portalServer;
let portalUrl;
let mainWindow;
let rememberedLoginStore;

// Software-rendered Chromium is more reliable on older PCs and avoids
// GPU-driver crashes that can appear as frozen input fields.
app.disableHardwareAcceleration();

async function createPortalWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    icon: path.join(__dirname, "..", "icon.ico"),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank" || url.startsWith(`${portalUrl}/`)) return { action: "allow" };
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch((error) => {
        console.error("Could not open the external link:", error);
      });
    }
    return { action: "deny" };
  });
  await loadAndShowWindow(mainWindow, portalUrl);
}

function restorePortalWindow() {
  if (!portalUrl) return;
  void focusOrCreateWindow(mainWindow, createPortalWindow).catch((error) => {
    console.error("Could not restore the GraceDesk window:", error);
    dialog.showErrorBox("GraceDesk", `The portal window could not be restored.\n\n${error.message}`);
  });
}

const SF9_PRINT_SELECTIONS = new Set([
  "All Without Attendance",
  "All with Attendance",
  "Term 1",
  "Term 2",
  "Term 3",
  "Attendance",
]);

ipcMain.handle("download-sf9-pdf", async (event, selection) => {
  if (!portalUrl || !event.senderFrame.url.startsWith(portalUrl)) {
    throw new Error("This request must come from GraceDesk.");
  }
  if (!SF9_PRINT_SELECTIONS.has(selection)) {
    throw new Error("Choose a valid SF9 print selection.");
  }

  const previewUrl = new URL("/api/grades/sf9", portalUrl);
  previewUrl.searchParams.set("all", "true");
  previewUrl.searchParams.set("format", "preview");
  previewUrl.searchParams.set("selection", selection);
  previewUrl.searchParams.set("pdf", "true");
  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await pdfWindow.loadURL(previewUrl.toString());
    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      landscape: true,
      printBackground: true,
      pageSize: "A4",
      margins: { marginType: "none" },
    });
    const filename = `SF9_All_Students_${new Date().toISOString().slice(0, 10)}.pdf`;
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath("downloads"), filename),
      filters: [{ name: "PDF files", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.writeFile(filePath, pdfBuffer);
    return { canceled: false, filePath };
  } finally {
    if (!pdfWindow.isDestroyed()) pdfWindow.destroy();
  }
});

let autoUpdater;
let updateBusy = false;

let availableUpdateVersion = null;

function sendUpdateStatus(status) {
  if (status.state === "available") availableUpdateVersion = status.version;
  else if (status.state === "current") availableUpdateVersion = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update-status", status);
  }
}

let activeCheck = null;

function runUpdateCheck() {
  if (!activeCheck) {
    activeCheck = checkForUpdatesWithRetry(() => getAutoUpdater().checkForUpdates())
      .finally(() => { activeCheck = null; });
  }
  return activeCheck;
}

async function checkForUpdatesInBackground() {
  if (!app.isPackaged || updateBusy) return;
  try {
    await runUpdateCheck();
  } catch (error) {
    console.error("Background update check failed:", error.message);
  }
}

function scheduleBackgroundUpdateChecks() {
  setTimeout(checkForUpdatesInBackground, 15 * 1000);
  setInterval(checkForUpdatesInBackground, 4 * 60 * 60 * 1000).unref();
}

ipcMain.handle("update-state", (event) => {
  assertTrustedSender(event);
  return { version: availableUpdateVersion };
});

function getAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require("electron-updater"));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = process.arch === "ia32" ? "latest-ia32" : "latest";
  autoUpdater.on("update-available", (info) => sendUpdateStatus({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => sendUpdateStatus({ state: "current", version: app.getVersion() }));
  autoUpdater.on("download-progress", (progress) => sendUpdateStatus({ state: "downloading", percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total }));
  autoUpdater.on("update-downloaded", (info) => sendUpdateStatus({ state: "downloaded", version: info.version }));
  autoUpdater.on("error", (error) => sendUpdateStatus({ state: "error", message: error.message }));
  return autoUpdater;
}

function assertTrustedSender(event) {
  if (!portalUrl || !event.senderFrame.url.startsWith(portalUrl)) {
    throw new Error("This request must come from GraceDesk.");
  }
}

ipcMain.handle("update-check", async (event) => {
  assertTrustedSender(event);
  if (!app.isPackaged) return { state: "unsupported", message: "Updates are available only in the installed app." };
  if (updateBusy) return { state: "busy" };
  try {
    const result = await runUpdateCheck();
    const info = result?.updateInfo;
    return info && result.isUpdateAvailable
      ? { state: "available", version: info.version }
      : { state: "current", version: app.getVersion() };
  } catch (error) {
    const message = getUpdateCheckErrorMessage(error);
    if (message) return { state: "error", message };
    throw error;
  }
});

ipcMain.handle("update-download", async (event) => {
  assertTrustedSender(event);
  if (!app.isPackaged) return { state: "unsupported" };
  if (updateBusy) return { state: "busy" };
  updateBusy = true;
  try {
    await createDatabaseBackup({ databasePath, backupDirectory });
    await getAutoUpdater().downloadUpdate();
    return { state: "downloaded" };
  } finally {
    updateBusy = false;
  }
});

ipcMain.handle("update-install", (event) => {
  assertTrustedSender(event);
  if (!app.isPackaged) return;
  setImmediate(() => {
    portalServer?.closeAllConnections?.();
    void createDatabaseBackup({ databasePath, backupDirectory }).finally(() => {
      getAutoUpdater().quitAndInstall(true, true);
    });
  });
});

ipcMain.handle("app-version", (event) => {
  assertTrustedSender(event);
  return app.getVersion();
});

ipcMain.handle("app-is-packaged", (event) => {
  assertTrustedSender(event);
  return app.isPackaged;
});

ipcMain.handle("choose-teacher-photo", async (event) => {
  assertTrustedSender(event);
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a teacher profile picture",
    properties: ["openFile"],
    filters: [{ name: "Image files", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  if (canceled || !filePaths[0]) return { canceled: true };

  const filePath = filePaths[0];
  const contentType = TEACHER_PHOTO_CONTENT_TYPES.get(path.extname(filePath).toLowerCase());
  if (!contentType) throw new Error("Choose a JPEG, PNG, or WebP image no larger than 2 MB.");
  const fileStat = await fs.stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_TEACHER_PHOTO_BYTES) {
    throw new Error("Choose a JPEG, PNG, or WebP image no larger than 2 MB.");
  }
  const photo = await fs.readFile(filePath);
  if (photo.length > MAX_TEACHER_PHOTO_BYTES) {
    throw new Error("Choose a JPEG, PNG, or WebP image no larger than 2 MB.");
  }
  return { canceled: false, contentType, base64: photo.toString("base64") };
});

function getRememberedLoginStore() {
  if (!rememberedLoginStore) throw new Error("Secure sign-in storage is not ready.");
  return rememberedLoginStore;
}

ipcMain.handle("remembered-login-save", (event, credentials) => {
  assertTrustedSender(event);
  return getRememberedLoginStore().save(credentials);
});

ipcMain.handle("remembered-login-load", (event) => {
  assertTrustedSender(event);
  return getRememberedLoginStore().load();
});

ipcMain.handle("remembered-login-update-password", (event, password) => {
  assertTrustedSender(event);
  return getRememberedLoginStore().updatePassword(password);
});

async function clearPortalAuthCookies() {
  if (!mainWindow || mainWindow.isDestroyed() || !portalUrl) return;
  const portalSession = mainWindow.webContents.session;
  const authCookieNames = new Set([
    "grade5_session",
    "grade5_session_teacher",
    "grade5_session_parents",
  ]);
  const cookies = await portalSession.cookies.get({ url: portalUrl });
  await Promise.all(cookies
    .filter((cookie) => authCookieNames.has(cookie.name))
    .map((cookie) => portalSession.cookies.remove(portalUrl, cookie.name)));
}

ipcMain.handle("portal-auth-cookies-clear", async (event) => {
  assertTrustedSender(event);
  await clearPortalAuthCookies();
});

ipcMain.handle("backup-list", async (event) => {
  assertTrustedSender(event);
  return listDatabaseBackups({ databasePath, backupDirectory });
});

ipcMain.handle("backup-create", async (event) => {
  assertTrustedSender(event);
  const result = await createDatabaseBackup({ databasePath, backupDirectory });
  if (!result.created) throw new Error("No usable local database is available to back up.");
  return result;
});

async function startPortal() {
  rememberedLoginStore = createRememberedLoginStore({
    safeStorage,
    filePath: path.join(app.getPath("userData"), "remembered-login.enc"),
  });
  await restoreBestDatabase({ databasePath, backupDirectory, legacyDatabasePaths });
  await createDatabaseBackup({ databasePath, backupDirectory });
  setInterval(() => {
    void createDatabaseBackup({ databasePath, backupDirectory });
  }, 6 * 60 * 60 * 1000).unref();

  const { createServer } = require("../server");
  portalServer = createServer({
    teacherOnly: true,
    databasePath,
    appearancePreferencesPath: path.join(canonicalDataDirectory, "appearance-preferences.json"),
    generatedReportsDirectory: path.join(app.getPath("downloads"), "generated-reports"),
    logFilePath: path.join(app.getPath("logs"), "portal-server.log"),
  });

  await new Promise((resolve, reject) => {
    portalServer.once("error", reject);
    portalServer.listen(0, "127.0.0.1", resolve);
  });

  portalUrl = `http://127.0.0.1:${portalServer.address().port}`;
  await createPortalWindow();
  scheduleBackgroundUpdateChecks();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", restorePortalWindow);

  app.whenReady().then(startPortal).catch(async (error) => {
    const logFilePath = path.join(app.getPath("logs"), "portal-server.log");
    const logEntry = `[${new Date().toISOString()}] Portal startup failed\n${error.stack || error}\n`;
    try {
      await fs.mkdir(path.dirname(logFilePath), { recursive: true });
      await fs.appendFile(logFilePath, logEntry, "utf8");
    } catch (logError) {
      console.error("Could not write the portal server log:", logError);
    }
    dialog.showErrorBox(
      "GraceDesk",
      `The portal could not start.\n\n${error.message}\n\nSee ${logFilePath} for details.`,
    );
    app.quit();
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && portalUrl) {
    restorePortalWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  portalServer?.close();
});