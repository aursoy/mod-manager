# Kt Mod Manager

Black-and-white Electron app for managing a FiveM `citizen` folder. It also has a Gun Lab for weapon skins and a Sound Lab for gun, footstep and kill sounds.

## Run

```
npm install
npm start
```

Or double-click `start.bat`.

## Pages

**Manage**
- **Dashboard**: link `FiveM.app/citizen` by dropping it in or using auto-detect. Shows stats, activity and a Launch FiveM button.
- **Graphics**: four tabs.
  - **Create with AI**: describe the pack you want. Add a picture to make it your sky, or a pack folder to build on. See below.
  - **Clouds**: a paint-program style editor for the cloud hats (`cloudhat_*.ytd`). They are found automatically in your pack, your `FiveM.app/mods` folder (inside any RPF, whatever it is called), citizen or GTA V. Brush, eraser, colour picker, paint bucket, zoom and pan; hue / saturation / brightness / contrast / tint with live preview, on one texture or **all clouds at once**; swap in your own picture while keeping the cloud's shape; flip, invert, black & white; undo/redo with a history list; hold to compare with the original. **Install clouds** writes them back in their original format (into the RPF they came from, backed up; GTA V's own clouds go into a new `mods/kt_clouds.rpf`) and checks the files on disk. Shortcuts: B, E, I, G, H, Space to pan, [ ] brush size, 0 fit, 1 actual size, Ctrl+Z / Ctrl+Y.
  - **Blood FX**: the same editor for your blood FX. Press **Choose blood FX RPF** (or drop the `.rpf` on the tab) and pick the RPF your blood is in. Blood is read from `fxdecal.ytd`, `peddamagedecals.ytd`, anything with "blood" in the name, and the particle file `core.ypt` (blood sprays; only its blood textures are shown), at any depth, nested RPFs included. An RPF with no textures says what is inside it. Recolour all of it at once (neon, black, confetti colours...), paint, or swap in a picture. **Install** puts the edited RPF into `FiveM.app/mods` under its own name (replacing it, backed up, if it is already there); **Save to folder** saves a copy. The file you picked is never changed.
  - **Advanced editor**: pick the **Pack** first: your game, any installed pack, or **Open a pack…** (a folder, `.zip` or `.rpf` anywhere, e.g. Downloads; timecycles are found at any depth). **Save to pack** writes the edit back into that pack (a `.bak` of the original is kept; an installed pack that is on updates the game too). Pick the weather and the area (Countryside or City; every game weather file has both), and see it in a live 3D day/night preview (a bay, a city whose windows light up at night, mountains in the fog, clouds, stars, sun and moon, all coloured by the file). Settings have plain names ("Sky colour (top)", "Moon size"). Click one to open it: every box is one time of day, and you only change the box you pick (there is also "use this colour all day"). Untouched values are saved exactly as they were. Save to game (backed up), save as a pack, or export. For files FiveM does not read (not named `w_*.xml`), "Use for sunny weather" copies it over the sunny and clear weather.
- **World**:
  - Water: removed / visible.
  - Player detail distance: fixes players a few metres away turning into blocky low-detail models. One click raises the ped LOD distances in `visualsettings.dat` (`ped.lod.distance.high/medium/low` to 150 / 250 / 400 m, and the in-car ones), on top of your pack's file. Default puts the file back.
  - Black mountains: changes how far the game draws in `visualsettings.dat` (`misc.Multiplier.farClipMultiplier`), on top of your pack's file. Removed / Visible plus a draw-distance slider; if your pack has its own "black mountains" section in that file, its lines are shown so you can change them directly. Switching back puts the file back exactly as it was.
  - Snow: snow for every weather type in `weather.xml` (Snow / SnowMist), with an amount slider.
  - Visual settings: every line of `visualsettings.dat`, searchable and editable, Save / Reset.
  - Player detail, Black mountains and the Visual settings editor each keep their own lines of `visualsettings.dat`, so switching one off never undoes another.
  - If citizen has no `visualsettings.dat` / `weather.xml`, the game's own copy is read from GTA V (update.rpf, then common.rpf).
  - Custom tweaks: any folder laid out like `citizen/` becomes a toggle.
- **Mods**:
  - **Graphics packs**: add a pack (a folder or `.zip`; or drop it on the page), switch it on or off, delete it. Pack files go to `citizen` and its `.rpf` files to `FiveM.app/mods`; everything is backed up and taken out again when the pack is switched off.
  - **FiveM.app/mods**: turning a mod off renames it to `.rpf.off`. You can also add mods or move them to the Recycle Bin.

**Create**
- **Gun Lab**: open a weapon `.rpf`, `.ytd` or `.ydr`. Nested OIV-style packages work too.
  - 3D preview of the model.
  - Recolour the skin.
  - **3D text**: real extruded, bevelled letters added to the gun's model. Click the gun where it goes; size, thickness, bevel, rotation, lift, front and side colour, Metal / Chrome / Gloss / Matte. Fonts: Impact, Arial Black, Bahnschrift, Georgia, Segoe Script (the real Windows font files), fonts that ship with the app, or any `.ttf` / `.otf` via **Font file**.
  - **Chain**: a hanging chain of real links from the spot you click (number of links, link size and thickness, colour, finish) with a pendant: your **logo** on a circle, square or heart plate, **text**, or none.
  - How it gets into the game: the parts are written into the weapon's `.ydr`, inside the model part they were placed on (same shader, they move with that part; the `_hi` copy gets them too). Their colours come from small patches painted into unused corners of the gun's texture (found from the model's UVs), with matching patches in the normal and specular maps. A model with data the app does not understand is left alone with a message.
  - Export, or install to `mods`.
  - A texture shared by several models (e.g. `_hi` copies) is edited once and written to all of them.
- **Sound Lab**: open `WEAPONS_PLAYER.rpf`, `RESIDENT.rpf` or a sound pack.
  - Banks are grouped into Guns, Footsteps, Kill/HUD and Other. Gun banks say which gun they are for ("Combat Pistol", "Micro SMG", "Heavy Sniper"...), read from the bank names (`ptl_combat`, `smg_micro`, `snp_heavy`); search by gun name.
  - Play any sound, or replace it with your own `.wav` / `.mp3` / `.ogg`, adjusting volume, pitch, trim, max length and fade.
  - Export the `.rpf`, or install it to `citizen/platform/audio/sfx`. Installs are backed up like every other citizen change.

**System**
- **Cache**: shows the size of each FiveM cache folder and cleans the ones you select.
- **Backups**: the original of every file the app changes is backed up first. "Restore everything" puts the folder back to stock.
- **Settings**: your own background (a picture or a looping MP4/WebM video, with Darken and Blur; or drop a file on the Settings page), **AI link** (see Pack AI), sounds (also a soft click when you change page), reduce motion, background effect, the tutorial (it also runs on first launch).

**Profile** (bottom left): your Discord name and avatar show up by themselves while the Discord desktop app is open (the app connects at start and every 30 s), and your Discord status says Kt Mod Manager. This needs the app's Discord application id once: create an application at https://discord.com/developers/applications (New Application, name it Kt Mod Manager), copy its Application ID and put it in `package.json` as `"discordAppId"`. Without it, each player can paste an Application ID in the profile window. You can also set a display name and avatar.

## Pack AI (Graphics → Create with AI)

Type what you want, and optionally add a picture and/or a pack folder:

> Use my picture as the actual sky, add stars, bigger moon, no water, FPS boost.

- **A picture as the sky**: GTA V's custom skies are the `starfield` picture inside `skydome.ytd` (what sky packs replace). Your picture is written into it, in its original size and format, and shows **all the time**: the day sky is darkened and the stars turned up so the picture is not washed out (say "only at night" if you want it at night only). It is written to both places FiveM can load it from: the sky RPF it came from in `FiveM.app/mods`, and `FiveM.app/citizen/platform/textures/skydome.ytd`. The sky is found by what is inside each RPF, not by its name: only an archive's file list is read (a few KB) until one with `skydome.ytd` turns up, nested RPFs included, so your mate's pack works whatever its RPFs are called, up to 2 GB each.
- **A pack folder or .zip** (folder button, or drop it on the chat): the AI builds on it. The new pack keeps every file of the original; the original folder is never changed.
- **Things you can ask for**: pvp pack; always night / always day; stars, moon, sun, clouds, fog, glow, distance blur with more / less / no / bigger / smaller; moods (sunset, night, neon/cyberpunk, vaporwave, apocalypse, overcast, foggy, stormy, winter, desert, cinematic, sunny); colours ("purple sky", "red tint"); darker / brighter / more vibrant; "no water", "no black mountains", "add snow" and the matching "have ..." / "no snow"; FPS boost (light / boost / max).
- Every answer says exactly what changed, and plainly when something could not be done (for example a timecycle with no moon size value).
- **It installs itself.** Press Create and the pack goes straight into your game. The app then reads the files back from disk and tells you exactly where your picture is. **Undo** takes everything back out, including world switches. If a file cannot be written (FiveM still open), it says so; close FiveM and press Install again. Keep chatting to change it ("now darker"); each new version replaces the last. **Fine-tune** opens it in the Advanced editor.
- **PvP packs**: "pvp pack" gives a clear view and steady FPS: no fog (`fog_density`), no glow (`postfx_intensity_bloom`), no distance blur (`dof_blur_far`), vivid colours and an FPS boost. "Always night" (or "no day") makes every hour of every weather look like midnight, the way only-night packs do; "always day" does the same with midday. "No sun" removes the sun disc.
- Water, black mountains and snow are the same switches as on the World page, and Undo puts them back too.
- FPS boost lowers LOD distance, shadow distance, ambient occlusion, light rays and motion blur, only where those values exist in the files.

It works offline; nothing is sent anywhere. For smarter answers, set an **AI link** in Settings: an API link, key and model. Anthropic (`https://api.anthropic.com`, default model `claude-opus-5-5`) goes through the official SDK; any other link is called as an OpenAI-style `/chat/completions` API (OpenAI, OpenRouter, Groq, LM Studio, Ollama...). The AI answers with a short reply and the pack changes as JSON, which are checked and built exactly like the offline reader's. The key is stored encrypted when the OS allows it. If the link fails, the offline reader takes over.

## Limits

- `citizen/platform/textures/skydome.ytd` is where FiveM loads its sky from (Cfx.re how-to); the sky RPF in `mods` is written as well, so either way the picture is there.
- Sky textures in BC7 or ATI format cannot be written yet; the sky colours still change.
- The editor's clock times for the 9 daily keyframes are approximate and only drive the preview. The values and their order in your file are never reordered.

- **Encrypted (NG/AES) RPFs** open after a one-time unlock: the app finds the archive key inside your own `GTA5.exe` (read-only, about 6 s) and caches it. Settings → Encrypted RPFs, or the prompt that appears when you open an encrypted pack. Edited archives are always saved as OPEN. The decryption is ported from [CodeWalker](https://github.com/dexyfex/CodeWalker) (MIT); see `vendor/codewalker/NOTICE.txt`.
- Gun textures are re-encoded in their original format and size. DXT1/3/5 and A8R8G8B8 can be edited; BC7 and ATI are locked.
- Sound streams are named by their hash (e.g. `0C1A2B3C`), because GTA does not store the names. Use the play buttons to find the sound you want.
- Replaced sounds are written as 16-bit PCM at the original sample rate. Multi-channel music banks are play-only.

## Dev

```
npm test                      # 67 tests, incl. an end-to-end run of every feature through the real IPC handlers (test/app.test.js)
node scripts/make-sample.mjs  # builds samples/ (test pistol + test sound pack)
node scripts/rpf-ls.js x.rpf  # list an archive's contents, including nested archives
```
