"use strict";

async function loadAndShowWindow(window, url) {
  const showWindow = () => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  };
  window.once("ready-to-show", showWindow);
  try {
    await window.loadURL(url);
  } catch (error) {
    window.removeListener("ready-to-show", showWindow);
    throw error;
  }
  showWindow();
  return window;
}

async function focusOrCreateWindow(window, createWindow) {
  if (!window || window.isDestroyed()) return createWindow();

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.focus();
  return window;
}

module.exports = { focusOrCreateWindow, loadAndShowWindow };
