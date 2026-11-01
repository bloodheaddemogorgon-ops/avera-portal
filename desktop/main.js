"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

let portalServer;
let portalUrl;
let mainWindow;

async function createPortalWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    icon: path.join(__dirname, "..", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
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
  await mainWindow.loadURL(portalUrl);
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
    activeCheck = getAutoUpdater().checkForUpdates().finally(() => { activeCheck = null; });
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
    if (/releases\.atom|No published versions|Cannot find latest\.yml|\b404\b/i.test(error.message)) {
      return {
        state: "error",
        message: "The update source is unavailable. The GitHub repository bloodheaddemogorgon-ops/avera-portal must be public and have a published release containing latest.yml.",
      };
    }
    throw error;
  }
});

ipcMain.handle("update-download", async (event) => {
  assertTrustedSender(event);
  if (!app.isPackaged) return { state: "unsupported" };
  if (updateBusy) return { state: "busy" };
  updateBusy = true;
  try {
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
    getAutoUpdater().quitAndInstall(true, true);
  });
});

ipcMain.handle("app-version", (event) => {
  assertTrustedSender(event);
  return app.getVersion();
});

async function startPortal() {
  const { createServer } = require("../server");
  portalServer = createServer({
    databasePath: path.join(app.getPath("userData"), "grade5-portal-database.sqlite"),
    appearancePreferencesPath: path.join(app.getPath("userData"), "appearance-preferences.json"),
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
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

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
    createPortalWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  portalServer?.close();
});