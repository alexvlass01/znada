# Znada

**Znada** automatically changes your Windows desktop wallpaper when you switch between
**light and dark mode** — a different wallpaper for day and night, and a separate one for
each monitor. It lives quietly in the system tray and runs in the background. The interface
is styled after GNOME's Adwaita, with light and dark themes.

> **Windows only.**

## ⬇️ Download

**[Download the latest version »](https://github.com/alexvlass01/znada/releases/latest)**

1. On the release page, download **`Znada-Setup.exe`**.
2. Double-click it — Znada installs and opens automatically (no setup wizard, like Discord or VS Code).
3. A short welcome screen helps you choose a language, turn on automatic switching and autostart, and create shortcuts.

Znada isn't code-signed yet, so Windows may show a warning the first time you run the installer: click **More info**, then **Run anyway**.

That's it. The app keeps running in the **system tray** after you close the window — you **don't** need to run the installer again to "turn it on".

## Features

- 🌗 **Separate wallpapers for day and night** — one for the light theme, another for dark.
- 🖥 **A different wallpaper per monitor**, with a visual monitor map.
- ⚡ **Automatic** — the wallpaper changes the moment Windows switches theme.
- 📚 **Wallpaper library** — keep all your wallpapers in one place: mark favourites, add tags, and browse folders. Open a folder to see what's inside, step into sub-folders, and find your way back with breadcrumbs.
- 🗂 **Live folders** — connect a folder and Znada will pick up new wallpapers you add there.
- 🔀 **Slideshow** — let a set of wallpapers rotate on a timer instead of showing just one picture.
- 🌐 **Online wallpapers** — search by tags and download fresh wallpapers right inside the app.
- 🖱 **Drag & drop** — drop an image straight onto the app to add it.
- 🌓 **Can switch the Windows theme itself** on a schedule — by fixed time or by sunrise/sunset for your location. A built-in replacement for "Auto Dark Mode".
- ⌨️ **Global hotkey** — jump to the next wallpaper with a keyboard shortcut.
- 🎮 **Game Mode** — pauses wallpaper and theme changes while you play games or use full-screen apps.
- 🥷 **Quiet switching** — when a full-screen window is open, Znada waits and changes the wallpaper without interrupting you.
- 🎚 **Fit modes:** fill, fit, stretch, center, tile, or span across monitors.
- 📌 **Tray app** that runs in the background; 🚀 optional **autostart** with Windows.
- 🌍 **30 languages** (or just follow your system language).
- 🎨 Clean **Adwaita-style** interface with light and dark palettes.

## How it works

- Znada watches the Windows light/dark setting (*Settings → Personalization → Colors → Mode*) and reacts instantly.
- It sets a separate wallpaper on each monitor using built-in Windows features — no extra software or drivers.
- Individual wallpapers you pick are copied into the app's own folder, so they don't disappear after an update or if you move the original. Connected live folders stay linked to their original location.

## Build from source (for developers)

```powershell
npm install
npm start            # run from source
npm run package      # local unpacked test build -> dist/Znada-win32-x64/
npm run installer    # installer        -> dist/installer/Znada-Setup.exe
```

Built primarily with Electron + plain HTML/CSS/JS, plus a small Windows thumbnail helper. The
renderer is framework-free today, but focused dependencies and build tooling are welcome when they
have a clear maintenance or measured performance payoff. Source setup remains a single `npm install`.

## License

All rights reserved. The source is published so it can be read; see [LICENSE](LICENSE).
