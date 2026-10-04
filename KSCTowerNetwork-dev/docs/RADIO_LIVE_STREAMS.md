# Live internet radio / stream stations — **not shipped**

This project does **not** currently implement tuning to third-party live audio streams (e.g. NPR, internet music) from the in-game radio or the web tower.

## What exists today

- **In-game radio** (`PluginSrc/TowerRadioGui.cs`) and **backend quick-tune metadata** (`backend/src/config/radioPresets.ts`) only expose the operational presets: TWR, GND, ATIS, EMRG — plus normal manual frequency entry for tower voice sessions.
- **Server-owned radio rooms** (`ksc-radio-*` in `backend/src/services/repository.ts`) exist only for the operational presets that must map to LiveKit voice channels (TWR, GND, EMRG). They are not used for internet streams.

## Why this doc exists

An earlier experiment added extra preset frequencies for “station” style content. That work is **fully disabled**: no lobby UI, no stream URLs in shipped code paths, no server rooms for stream-only channels.

## If you add it later

Expect to implement **client-side only** playback in the plugin (Unity `AudioSource` + HTTP stream, with clear UX and failure handling), and keep the backend out of stream relay unless you deliberately design a proxy. Do not reuse `ksc-radio-*` session rows for streams unless you intend them to participate in the same voice-room model.
