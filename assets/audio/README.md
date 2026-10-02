# Tribute recordings

The loser of each game owes the winner a song. This folder holds them, and the middle card on the
home page plays whichever one is current.

## Naming convention

```
peon-anthemW<week><a|b>.mp3
                   │   └── a = that week's Thursday game
                   │       b = that week's Monday game
                   └────── week number
```

So `peon-anthemW4a.mp3` is the song owed for the Thursday game of week 4, and `peon-anthemW4b.mp3`
will be the Monday one. Keeping every file means the back catalogue stays intact instead of each
week overwriting the last.

## Pointing the site at a new one

One line, in `CONFIG.tribute` at the top of `assets/js/app.js`:

```js
tribute: {
  file: 'assets/audio/peon-anthemW4b.mp3',
  title: '',     // optional — shown in quotes above the player
  url: '',       // optional — adds a "Listen on …" credit link
  host: 'Suno'
},
```

The card works out who sings and who it is for from the score, so only `file` has to change. Leave
`title` and `url` empty and the card simply omits them. If the file is missing, the play button
disables itself and the credit link (when set) is still the way in.

## Format

- **MP3, 128–192 kbps, stereo** is the right target: every browser plays it, and a three-minute song
  lands around 3–4 MB. 44.1 kHz and 48 kHz are both fine.
- If you are re-recording a stream rather than downloading a master, keep the bitrate at the higher
  end — you are encoding already-compressed audio, and the headroom is what stops the second pass
  from adding audible artefacts.
- Keep files under ~20 MB. GitHub refuses anything over 100 MB.

## Current contents

| File | What it is |
| --- | --- |
| `peon-anthemW4a.mp3` | MW's tribute for the Thursday game (Browns over Steelers) — 4:18 |
| `peon-anthem.mp3` | MW's first tribute, "John, The King of the Ball" — 1:56 |
| `peon-anthem1.mp3` | DrJ's original tribute, converted from the phone recording — 0:22 |
| `footballpeontribute.amr` | the raw phone recording behind `peon-anthem1.mp3`, kept for provenance |

## Converting phone formats

**No browser plays `.amr`** — not Chrome, Safari, Firefox or Edge. Windows can convert it with
nothing installed, since Media Foundation decodes AMR-NB natively (see the commit that added
`peon-anthem1.mp3` for the PowerShell). With ffmpeg it is one line:

```bash
ffmpeg -i recording.amr -codec:a libmp3lame -b:a 128k peon-anthemW4b.mp3
```
