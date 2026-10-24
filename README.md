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
- **Graphics**: install graphics packs from a folder or `.zip`, and toggle or remove them. Colour grading tints every `*_col_r/g/b` value in the timecycle XMLs. Applying a grade again replaces the last one instead of stacking on it.
- **World**:
  - Water: removed / visible.
  - Black mountains: load the files from your pack once, then switch between removed and visible.
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

## Limits

- **Encrypted (NG/AES) RPFs** open after a one-time unlock: the app finds the archive key inside your own `GTA5.exe` (read-only, about 6 s) and caches it. Settings → Encrypted RPFs, or the prompt that appears when you open an encrypted pack. Edited archives are always saved as OPEN. The decryption is ported from [CodeWalker](https://github.com/dexyfex/CodeWalker) (MIT); see `vendor/codewalker/NOTICE.txt`.
- Gun textures are re-encoded in their original format and size. DXT1/3/5 and A8R8G8B8 can be edited; BC7 and ATI are locked.
- Sound streams are named by their hash (e.g. `0C1A2B3C`), because GTA does not store the names. Use the play buttons to find the sound you want.
- Replaced sounds are written as 16-bit PCM at the original sample rate. Multi-channel music banks are play-only.

## Dev

```
npm test                      # 9 tests: RPF, textures, DXT, citizen, AWC, Sound Lab, mods, cache, presets
node scripts/make-sample.mjs  # builds samples/ (test pistol + test sound pack)
node scripts/rpf-ls.js x.rpf  # list an archive's contents, including nested archives
```
