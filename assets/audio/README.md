# Drop the peon's recording here

Name the file `peon-anthem` and keep whatever extension your recorder gave you:

```
assets/audio/peon-anthem.mp3     <- best default
assets/audio/peon-anthem.m4a     <- what iPhone Voice Memos exports, works as-is
assets/audio/peon-anthem.wav     <- fine, just large
assets/audio/peon-anthem.ogg
assets/audio/peon-anthem.aac
assets/audio/peon-anthem.opus
```

The page probes those extensions in that order and plays the first one that exists — no code change needed. Commit the file, push, and the player on the home page arms itself.

## Which format

- **MP3, 128–192 kbps** is the safest choice: every browser plays it and a 3-minute song lands around 3 MB.
- **M4A/AAC** is what an iPhone voice memo produces. Upload it as-is; Safari and Chrome both play it.
- **WAV** works but is roughly 10× the size (~30 MB for 3 minutes), which is a slow load on cell service. Convert it if you can:
  ```bash
  ffmpeg -i peon-anthem.wav -codec:a libmp3lame -b:a 192k peon-anthem.mp3
  ```
- Keep it under ~20 MB. GitHub blocks files over 100 MB outright.

## AMR and other phone formats

**No browser plays `.amr`** — not Chrome, Safari, Firefox or Edge. Android voice recorders and some
phone apps still produce it, so it has to be converted before it goes on the page.

`footballpeontribute.amr` in this folder is the original recording, kept for provenance.
`peon-anthem.mp3` is the converted copy the site actually plays.

Windows can do the conversion with no software installed — Media Foundation decodes AMR-NB natively:

```powershell
# Windows PowerShell 5.1 (not pwsh 7)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
# ...MediaTranscoder + MediaEncodingProfile::CreateMp3 — see the commit that added this file
```

With ffmpeg it is one line:

```bash
ffmpeg -i footballpeontribute.amr -codec:a libmp3lame -b:a 128k peon-anthem.mp3
```

## Renaming

To use a different filename, change `CONFIG.anthem.basename` at the top of `assets/js/app.js`.

Until a file is present, the player shows its "the peon has not yet paid his debt" state instead.
