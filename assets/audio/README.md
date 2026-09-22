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

## Renaming

To use a different filename, change `CONFIG.anthem.basename` at the top of `assets/js/app.js`.

Until a file is present, the player shows its "the peon has not yet paid his debt" state instead.
