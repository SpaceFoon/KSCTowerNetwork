# Audio assets

## `launch-countdown.mp3`

Drop a NASA-style 10-second launch countdown audio clip here as
`launch-countdown.mp3`. NASA materials are generally public domain in the United
States; suitable clips are available on
[archive.org](https://archive.org/details/NASA_Audio_Collection) and the NASA
public audio library.

The countdown panel (`web/src/session/CountdownPanel.tsx`) tries to play this
file when a controller starts the T-10 countdown. **If the file is missing or
playback is blocked**, the panel falls back to a Web Audio beep cadence
(descending tones at T-5..T-1 plus a sustained chord at T-0), so the feature
still works without any asset.

Recommendations:

- Length: ≥ 10 seconds (longer is OK; the panel offsets playback to align with
  the controller's "Start" press).
- Format: any browser-supported encoding (MP3 is the safest cross-browser bet).
- Loudness: normalize so it sits below the LiveKit voice mix.
