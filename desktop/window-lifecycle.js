"use strict";

async function focusOrCreateWindow(window, createWindow) {
  if (!window || window.isDestroyed()) return createWindow();

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.focus();
  return window;
}

module.exports = { focusOrCreateWindow };
