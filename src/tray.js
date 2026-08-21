'use strict';

const path = require('path');
const fs = require('fs');

// Pure: builds the tray context-menu template (array of items) from state.
// No Electron dependency, so the conditional menu logic is unit-testable.
//   state:   { theme, updateState, slideshowEnabled, hasSlideshowItems }
//   t:       i18n function (key -> label)
//   actions: { onOpen, onApplyCurrent, onNextWallpaper, onInstallUpdate, onQuit }
function buildMenuTemplate(state, t, actions) {
  const items = [
    { label: t('tray.open'), click: actions.onOpen },
    { label: t('tray.applyCurrent'), click: actions.onApplyCurrent },
  ];
  if (state.slideshowEnabled || state.hasSlideshowItems) {
    items.push({ label: t('tray.nextWallpaper'), click: actions.onNextWallpaper });
  }
  if (state.updateState === 'ready') {
    items.push({ type: 'separator' }, { label: t('tray.installUpdate'), click: actions.onInstallUpdate });
  }
  items.push({ type: 'separator' }, { label: t('tray.quit'), click: actions.onQuit });
  return items;
}

// System-tray controller. Electron objects, i18n, state and actions are INJECTED
// so this module has no direct coupling to app state.
//   deps: { Tray, Menu, nativeImage, assetsDir, t, getState,
//           onOpen, onApplyCurrent, onNextWallpaper, onInstallUpdate, onQuit }
function createTrayController(deps) {
  const { Tray, Menu, nativeImage, assetsDir, t, getState } = deps;
  let tray = null;

  const refresh = () => {
    if (tray) tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(getState(), t, deps)));
  };

  // ICO предпочтительнее PNG: в нём лежат кадры 16/20/24/32, и Windows берёт
  // готовый под текущий масштаб экрана вместо того, чтобы ужимать один PNG.
  // 16-й кадр нарисован попиксельно, downscale его бы размыл. PNG остаётся
  // запасным путём — на случай сборки без иконок нового формата.
  const trayIconPath = (theme) => {
    const base = theme === 'dark' ? 'tray-dark' : 'tray-light';
    const candidates = [`${base}.ico`, `${base}.png`, 'tray.ico', 'tray.png'];
    for (const name of candidates) {
      const p = path.join(assetsDir, name);
      if (fs.existsSync(p)) return p;
    }
    return path.join(assetsDir, 'tray.png');
  };

  const refreshIcon = () => {
    if (!tray) return;
    tray.setImage(nativeImage.createFromPath(trayIconPath(getState().theme)));
  };

  const create = () => {
    tray = new Tray(nativeImage.createFromPath(trayIconPath(getState().theme)));
    tray.setToolTip('Znada');
    refresh();
    refreshIcon();
    tray.on('click', deps.onOpen);
    tray.on('double-click', deps.onOpen);
    return tray;
  };

  const destroy = () => { if (tray) { try { tray.destroy(); } catch {} tray = null; } };

  return { create, refresh, refreshIcon, destroy };
}

module.exports = { createTrayController, buildMenuTemplate };
