"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gradePortal", {
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
