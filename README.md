# IslandCut

A desktop video editor for **Fortnite / UEFN game trailers and gameplay trailers**, with an **Auto Trailer** that edits for you.
It's built with Electron, React, TypeScript and Vite, and uses bundled native **FFmpeg / FFprobe** for decoding, proxies, analysis and export.

> **Just want the app?** Download **IslandCut-Setup** from the [latest release](https://github.com/NLRyanNL/island-cut/releases/latest).
> This repository is the full source code, public so anyone can check exactly what the app does.

**Privacy:** IslandCut works offline on your own PC. Your clips and projects never leave it. The only things it sends over the internet:
- a check of this repository's GitHub releases for a newer version;
- calls to Anthropic, and only if you add your own API key for the optional AI features in Auto Trailer.

---

## Quick start (Windows)

- **Install as a normal app:** double-click **`install-app.bat`**. It builds the installer and installs IslandCut for your user (no admin needed), with a Start-menu and desktop shortcut. Right-click the taskbar icon → **Pin to taskbar**. Run it again after updates.
- **Develop:** double-click **`start-dev.bat`** (or run `npm run dev`).
- **Share it for free:** double-click **`make-public-release.bat`**. It makes an installer and a portable .exe with none of your personal info (checked automatically). See **RELEASE-GUIDE.md** for posting it and counting downloads/installs (`check-downloads.bat`).
- **Full check:** **`run-selftest.bat`** installs, type-checks, runs all tests, builds, drives the app through a scripted edit and export, and builds the installer. Logs go to the `logs` folder.

## Setup (manual)

1. Install **Node.js 20 LTS or newer** from <https://nodejs.org> (choose "LTS"), then reopen your terminal.
2. Open a terminal in this folder (in Explorer: right-click inside the folder, then **Open in Terminal**) and run:

```powershell
npm install
npm run dev
```

`npm install` downloads Electron and the Windows FFmpeg/FFprobe binaries. That takes a few minutes the first time.
`npm run dev` starts the editor with hot reload.

### Build a Windows installer (.exe)

```powershell
npm run dist
```

The installer is created in `release\IslandCut Setup 0.1.0.exe`.
A portable unpacked build is in `release\win-unpacked\`.

### Other commands

| Command | What it does |
|---|---|
| `npm run build` | Production build into `dist/` (UI + Electron main) |
| `npm start` | Run the production build (after `npm run build`) |
| `npm test` | Unit and integration tests (timeline ops, beat detection, FFmpeg export) |
| `npm run typecheck` | TypeScript type check |

---

## How to use

1. **Import** clips, music, sound effects and images. Drag them into the Media Bin or click **+ Import**.
   Low-res **proxies** are made in the background; the progress shows on each thumbnail. The preview plays proxies, and export always uses the **original files**.
2. **Drag** media onto the timeline. You get 4 video tracks, 4 audio tracks (Game / Music / SFX / Voice) and a text track. Add more tracks with **+V / +A / +T**.
3. **Edit:**
   - Move clips between tracks.
   - Trim either edge.
   - Split, delete or ripple delete.
   - Snapping works to the playhead, clip edges and markers. Hold **Alt** while dragging to bypass it.
4. **Inspector** (right panel): transform, keyframes, speed and ramps, color, effects, audio and text for the selected clip. With nothing selected it shows project settings: aspect, fps, ducking and loudness.
5. **Export** (Ctrl+E): pick a preset, then **Export** or **Add to queue** to render several versions in a row.

### Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| J / K / L | Shuttle reverse / stop / forward (press repeatedly for 2×, 4×, 8×) |
| ← / → | Step a frame (Shift = 10 frames) |
| ↑ / ↓ | Previous / next edit point |
| C or Ctrl+B | Split at playhead |
| Delete | Delete selected clips |
| Shift+Delete | Ripple delete |
| M | Add marker |
| I / O | In / Out points (export range) |
| + / − | Timeline zoom (Ctrl+mouse wheel works too) |
| Shift+Z | Zoom to fit |
| S | Toggle snapping |
| T | Add text at playhead |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+D | Duplicate selection |
| Ctrl+S / Ctrl+Shift+S | Save / Save as |
| Ctrl+Shift+E | Export current frame as PNG |
| F1 | Shortcut list |

### Auto Trailer

Click **Auto Trailer** in the top bar:

1. Pick **Gameplay trailer** (in-game UI allowed) or **Cinematic trailer** (no UI allowed).
2. Add your clips (drag them in), then **your own music**. Listen to it, and click the waveform to choose which part of the song plays; *Skip quiet intro* jumps to where it gets going. Then set the **exact length** (quick picks from 15 s to 2 min, or type any length from 8 to 180 s) and the format (16:9, 9:16, 1:1).
3. Add your **logo** (transparent PNG) and your **island thumbnail** (1920×1080). The logo becomes the title reveal and sits on the end card, and the thumbnail is the end-card background. No logo yet? **Make a logo** opens the Logo Maker.
4. Describe the style, e.g. *"60s horror trailer, slow creepy build, then fast cuts on the beat, title "KILLER CLOWN", code 1234-5678-9012, coming soon"*.
5. IslandCut analyzes every second of footage for motion, loudness, impacts, scene cuts, dark or menu shots, the **HUD** and **gunfire**. It then writes an **editable concept**: sections, cut speed, energy, transitions, titles and the picked shots (swap or untick any shot).
6. **Build timeline** creates a normal, fully editable project: beat-synced cuts, slow-mo, looks, transitions, titles, end card with island code, and music with fades.

What it does about Epic's rules:

- **No gunfire:** moments with active gunfire (detected from the audio) are never picked. Anything uncertain is flagged in the concept.
- **No UI in cinematic trailers:** the static HUD (minimap, health bar, inventory, crosshair) is detected and removed with a zoom/crop away from it. Small leftovers are filled from the surrounding pixels. This is not true AI generative fill; footage recorded with the HUD hidden (UEFN Sequencer / replay cameras) is always the cleanest for Epic's review.

**Optional Claude AI:** add an Anthropic API key in **Settings**. It's stored encrypted with Windows' data protection and never written into project files. With a key, Claude reviews sample frames for HUD and gunfire and writes the concept from your description. Without a key, everything works offline.

### Boo, sound effects and help

**Boo** the ghost is IslandCut's mascot. He runs the first-launch tour, gives tips, and dances while IslandCut works (exports, Auto Trailer, imports), with a rotating trailer tip underneath.

- **Built-in sound effects:** in the Media panel, open the **SFX** tab. It has whooshes, a riser, a boom, a hit, a braam, a sub drop, a glitch, a heartbeat, a camera click and a coin. They're generated by IslandCut, so they're free to use anywhere. Auto Trailer adds them automatically: whooshes and hits on transitions, a riser and boom on the title reveal, and a boom on the end card.
- **Interface size:** Settings → Interface size. Auto picks a size for your screen.
- **? menu:** check for updates, or **Report a problem** to save a privacy-safe report file.

### Transitions and fades

Select a clip → **Effects**. Pick from **36 transitions** in seven groups:
- **Fade:** crossfade, blur dissolve, through black or white, flash, light leak, film burn
- **Slide & push:** in four directions
- **Wipe:** four directions, diagonal, blinds, bars
- **Shape:** circle, diamond, clock
- **Zoom & spin:** zoom in, zoom punch, zoom blur, spin
- **Motion:** whips in four directions, impact shake
- **Stylized:** glitch, RGB split

**All cuts** applies the transition to every cut on that track. **Fade picture** fades a clip in or out to black, white or transparent. You can also right-click a clip on the timeline for the most-used transitions.

### Fonts and the Logo Maker

IslandCut ships about 60 free fonts for trailers and games (Bebas Neue, Anton, Luckiest Guy, Bangers, Orbitron, Black Ops One, Creepster, Cinzel…). They're downloaded once when you build and are free to use in your videos (SIL Open Font License). The font picker shows them first, grouped by style with live previews, followed by your installed fonts.

**Logo** in the top bar (or Tools → Logo Maker) has two modes:
- **Make a text logo:** pick a style (Battle Royale, Sticker, Horror, Sci-fi, Cinematic, Arcade, Clean, Graffiti), then change the font, gradient, outline, white sticker border, 3D depth, glow and tilt.
- **Remove an image's background:** the background colour is found automatically (or click a colour). Only the outside is removed, so matching colours inside the logo are kept.

Either way you get a transparent PNG that's saved and added to your media.

### Beginner help

A short tour runs the first time you open the app. You can replay it from **Help (?) → Show the quick tour**. Tip cards explain each panel, and the line in the timeline toolbar always tells you what to do next. Turn tips off from **Help (?) → Hide beginner tips**.

### Audio tools (right-click a clip)

- **Extract Audio** moves a video's audio to its own linked audio track. **Unlink** separates them so you can edit or mute each one.
- **Export audio as MP3/WAV** exports one clip, or use **♫ Audio ▾** in the top bar for the whole timeline.
- **Detect Beats** (on a music clip) places beat markers. The red ones are downbeats.
  - **♪ Snap to beats** makes cuts snap to beats.
  - **Auto-cut to beat** (on a video clip) slices it on every beat or every 2nd/4th beat.
- **Volume** has a slider in the Inspector, and you can drag the yellow line on the clip. **Alt+click** the line adds a keyframe; drag keyframes to move them and double-click to delete. The white corner dots are **fade handles**.
- **Auto-ducking** is in Inspector → project settings. Music tracks get quieter whenever a Voice or SFX track has sound.
- **Loudness**: exports are normalized to **-14 LUFS** (YouTube) by default, using two-pass loudnorm.
- **SFX folder**: open the Media Bin's SFX tab and choose a folder with your whooshes, hits and risers. Drag them straight onto the timeline.

---

## Project files

Projects are saved as `*.islandcut.json`. Media paths are stored **relative to the project file**, so you can move the project folder together with its media.
Every **30 seconds** IslandCut writes a recovery copy of your work (your project file itself only changes when you press Save). After a crash, **File → Recover Autosave** brings back the unsaved work.
If media has moved, a **Relink** dialog appears. Locate one file and the others in the same folder are found automatically.

---

## Architecture

```
electron/                 Main process (Node)
  main.ts                 window, menu, lifecycle
  preload.ts              safe API bridge (window.api)
  ipc.ts                  IPC handlers
  mediaProtocol.ts        media:// protocol with HTTP Range (video seeking)
  ffmpeg/                 binaries, process runner (progress/cancel), probe,
                          proxies + filmstrips, thumbnails, waveforms, reverse/freeze
  export/exporter.ts      runs an export job (2-pass loudness, progress, cancel)
  audio/                  beat detection + ducking (main side)
  project/projectIO.ts    save/load with relative paths, atomic writes, relink search
  worker.ts               analysis worker thread (CPU-heavy DSP)
shared/                   Pure TypeScript used by both sides
  types.ts                project / clip / track model
  timelineOps.ts          move, trim, split, ripple, snapping, extract audio, auto-cut
  keyframes.ts            easing, keyframes, speed-ramp time remapping
  evaluate.ts             what every layer looks like at time t (transform, transitions, shake)
  color.ts                color grade + looks + .cube LUTs baked into one 3D LUT
  ducking.ts, beatDetect.ts
  render/buildGraph.ts    timeline → FFmpeg filter graph
src/                      React UI (renderer)
  store/                  state store, undo/redo, actions
  preview/                WebGL compositor, playback engine, title renderer
  components/             Media Bin, Preview, Inspector, Timeline, dialogs
  export/queue.ts         render queue
  presets/                title presets + project templates
tests/                    node:test suites (run with npm test)
```

### How the timeline becomes an FFmpeg command

1. Each visual clip becomes one FFmpeg input, accurately seeked with `-ss` / `-t` on the **original** file.
2. Each clip goes through its own chain:
   - `setpts` maps source time to timeline time (speed ramps use a piecewise curve).
   - `fps` makes the frame rate constant; `tpad` fills missing transition handles.
   - The frame is scaled to fit/fill, converted to RGBA, then graded with `lut3d` and `vignette`.
   - Animated filters follow, driven per frame by `sendcmd`: blur, RGB shift, dip colour, opacity, rotation and size.
3. The layers are composited bottom-to-top with `overlay` on a background color. Position is an expression of `t`.
4. Audio clips are trimmed, time-stretched with `atempo`, enveloped with `volume` (keyframes, fades, ducking), delayed with `adelay` and mixed with `amix`. An optional 2-pass `loudnorm` follows.
5. The output is H.264/H.265 + AAC MP4, BT.709 tagged. FFmpeg runs as a child process, so the UI never freezes; **Cancel** kills it.

The animated values come from `shared/evaluate.ts`, the **same code the WebGL preview uses**, so preview and export match.
Titles are drawn by the same canvas renderer in both places; for export they are rendered to PNG frames.

---

## Troubleshooting

- **"FFmpeg binary not found"**: run `npm rebuild ffmpeg-static`. It downloads the binary from GitHub, so it needs internet access.
- **Preview says "Generating proxy…"**: wait for the proxy bar on the thumbnail to finish. MKV/HEVC files only play once their proxy is ready.
- **Black preview / WebGL error**: update your graphics driver.
- **Export failed**: the error dialog shows FFmpeg's message. Temporary job files are in `%APPDATA%\IslandCut\cache\jobs`.
- Caches (proxies, waveforms, thumbnails) live in `%APPDATA%\IslandCut\cache`. They're safe to delete.
