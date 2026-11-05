"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gradePortal", {
  getAppVersion: () => ipcRenderer.invoke("app-version"),
  isPackaged: () => ipcRenderer.invoke("app-is-packaged"),
  saveRememberedLogin: (credentials) => ipcRenderer.invoke("remembered-login-save", credentials),
  updateRememberedPassword: (password) => ipcRenderer.invoke("remembered-login-update-password", password),
  clearRememberedLogin: () => ipcRenderer.invoke("remembered-login-clear"),
  restoreRememberedLogin: () => ipcRenderer.invoke("remembered-login-restore"),
  clearPortalAuthCookies: () => ipcRenderer.invoke("portal-auth-cookies-clear"),
  downloadSF9Pdf: (selection) => ipcRenderer.invoke("download-sf9-pdf", selection),
  checkForUpdates: () => ipcRenderer.invoke("update-check"),
  getUpdateState: () => ipcRenderer.invoke("update-state"),
  downloadUpdate: () => ipcRenderer.invoke("update-download"),
  installUpdate: () => ipcRenderer.invoke("update-install"),
  createDataBackup: () => ipcRenderer.invoke("backup-create"),
  listDataBackups: () => ipcRenderer.invoke("backup-list"),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("update-status", listener);
    return () => ipcRenderer.removeListener("update-status", listener);
  },
});
