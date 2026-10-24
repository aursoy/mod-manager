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
- **Graphics**: three tabs.
  - **My packs**: add packs (drop a folder or `.zip`), switch them on and off, delete them. **Colour tint** tints every timecycle in your game, with a live preview of the result. Applying again replaces the last tint; Reset tint removes it.
  - **Create with AI**: describe the pack you want. Add a picture to make it your sky, or a pack folder to build on. See below.
  - **Advanced editor**: open any timecycle XML from your game (or your computer). Pick the weather and the area (Countryside or City; every game weather file has both), and see it in a live day/night preview. Settings have plain names ("Sky colour (top)", "Moon size"). Click one to open it: every box is one time of day, and you only change the box you pick (there is also "use this colour all day"). Untouched values are saved exactly as they were. Save to game (backed up), save as a pack, or export. For files FiveM does not read (not named `w_*.xml`), "Use for sunny weather" copies it over the sunny and clear weather.
- **World**:
  - Water: removed / visible.
  - Black mountains, Trees, Bushes, Props: these need removal files that come with some packs. Until you add them, the card says "Not set up" instead of showing a switch.
  - Custom tweaks: any folder laid out like `citizen/` becomes a toggle.
- **Mods**: lists `FiveM.app/mods`. Turning a mod off renames it to `.rpf.off`. You can also add mods or move them to the Recycle Bin.
- **Presets**: save your current packs, tweaks, colour grade and enabled mods, then switch back in one click.

**Create**
- **Gun Lab**: open a weapon `.rpf`, `.ytd` or `.ydr`. Nested OIV-style packages work too.
  - 3D preview of the model.
  - Recolour, and add 3D-style text. Drag the text on the texture, or click a spot on the model to place it.
  - Export, or install to `mods`.
  - A texture shared by several models (e.g. `_hi` copies) is edited once and written to all of them.
- **Sound Lab**: open `WEAPONS_PLAYER.rpf`, `RESIDENT.rpf` or a sound pack.
  - Banks are grouped into Guns, Footsteps, Kill/HUD and Other.
  - Play any sound, or replace it with your own `.wav` / `.mp3` / `.ogg`, adjusting volume, pitch, trim, max length and fade.
  - Export the `.rpf`, or install it to `citizen/platform/audio/sfx`. Installs are backed up like every other citizen change.

**System**
- **Cache**: shows the size of each FiveM cache folder and cleans the ones you select.
- **Backups**: the original of every file the app changes is backed up first. "Restore everything" puts the folder back to stock.
- **Settings**: sounds, reduce motion, background effect, notification test.

**Profile** (bottom left): set a display name and avatar, or link Discord to show your Discord name and avatar and set your Discord status. Linking Discord needs:
- the Discord desktop app running
- a free Application ID from https://discord.com/developers/applications (New Application, then copy the Application ID)

## Pack AI (Graphics → Create with AI)

Type what you want, and optionally add a picture and/or a pack folder:

> Use my picture as the actual sky, add stars, bigger moon, no water, FPS boost.

- **A picture as the sky**: GTA V paints the daytime sky from colours, but the night sky is a picture: the `starfield` texture inside `skydome.ytd` (the same file sky mods replace). Your picture is written into that texture, in its original size and format. It shows at night with the stars; say "all day" to keep it on in the daytime too (experimental: the day sky is darkened so the picture shows through). The sky colours are also taken from your picture. `skydome.ytd` is taken from the pack you added, then your citizen folder, then your own GTA V (`x64a.rpf`). GTA V is found through FiveM's `CitizenFX.ini`, and the archive is unlocked automatically the first time (read-only, about 10 seconds). There is no popup: if the file really cannot be found, the chat says so, uses the picture's colours for the sky, and offers a link to choose the file.
- **A pack folder or .zip** (folder button, or drop it on the chat): the AI builds on it. The new pack keeps every file of the original; the original folder is never changed.
- **Things you can ask for**: stars, moon, sun, clouds, fog, glow with more / less / no / bigger / smaller; moods (sunny, sunset, sunrise, night, overcast, foggy, stormy, neon/cyberpunk, vaporwave, winter, desert, apocalypse, cinematic, realistic); colours ("purple sky", "red tint"); darker / brighter / more vibrant; "no water", "no black mountains", "no trees", "no bushes", "no props" and the matching "have ..."; FPS boost (light / boost / max).
- Every answer says exactly what changed, and plainly when something could not be done (for example a timecycle with no moon size value, or trees whose removal files are not loaded yet).
- Chat on to refine it ("now make it darker"), drag the time slider to check day and night, then **Install pack**. It appears under My packs and can be switched off any time. **Fine-tune** opens the result in the Advanced editor.
- Water works out of the box. Black mountains, trees, bushes and props switch only after you load their removal files on the World page once.
- FPS boost lowers LOD distance, shadow distance, ambient occlusion, light rays and motion blur, only where those values exist in the files.

It works offline with a built-in reader. Add an Anthropic API key in Settings → Pack AI key and Claude reads your requests (and looks at your picture) instead. The key stays on your PC and is only sent to Anthropic when you press Create.

## Limits

- The Pack AI cannot create the files that remove trees, bushes, props or black mountains; it switches them once you have loaded them.
- When `skydome.ytd` did not come from a pack, it is installed to `citizen/platform/textures/skydome.ytd`. If your FiveM build does not pick it up there, use the file from the pack (it then keeps the pack's own path).
- Sky textures in BC7 or ATI format cannot be written yet; the sky colours still change.
- The editor's clock times for the 9 daily keyframes are approximate and only drive the preview. The values and their order in your file are never reordered.

- **Encrypted (NG/AES) RPFs** open after a one-time unlock: the app finds the archive key inside your own `GTA5.exe` (read-only, about 6 s) and caches it. Settings → Encrypted RPFs, or the prompt that appears when you open an encrypted pack. Edited archives are always saved as OPEN. The decryption is ported from [CodeWalker](https://github.com/dexyfex/CodeWalker) (MIT); see `vendor/codewalker/NOTICE.txt`.
- Gun textures are re-encoded in their original format and size. DXT1/3/5 and A8R8G8B8 can be edited; BC7 and ATI are locked.
- Sound streams are named by their hash (e.g. `0C1A2B3C`), because GTA does not store the names. Use the play buttons to find the sound you want.
- Replaced sounds are written as 16-bit PCM at the original sample rate. Multi-channel music banks are play-only.

## Dev

```
npm test                      # 41 tests: RPF, textures, DXT, citizen, AWC, Sound Lab, mods, cache, presets, timecycle editor, Pack AI, sky texture, dropped packs
node scripts/make-sample.mjs  # builds samples/ (test pistol + test sound pack)
node scripts/rpf-ls.js x.rpf  # list an archive's contents, including nested archives
```
