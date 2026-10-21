# Migration parity audit - October 10, 2026

Compared legacy tracked source against the new checkout, normalized line endings,
and inspected the legacy working-tree edits. This is source and local browser
parity evidence; it does not replace a live KSP voice/telemetry session.

## Restored work

- Starfield, planet artwork, rotating WebGL globe inspector, clouds, rings,
  expanded controls, texture registry/importer and local optional textures.
- Tower Desk and Tower Wall session IDs reach the globe inspector, so matching
  live PNG terrain takes precedence over local stock textures.
- Wall maps fill the available slot without edge cropping. Terrain and overlay
  stretch together; unusual slot shapes distort the projection. Desk aspect
  behavior remains unchanged.

Flightwall, saved craft thumbnails, site colors and radar sweep repainting were
already present. Plugin C# source matches the legacy checkout. Backend differences
are test/config isolation; voice bridge differences include the newer SDK and
room-handler preservation fix. Other web differences are strict TypeScript fixes,
chart viewer/installation improvements, current local ports and slower globe
rotation. No further missing feature code was found in this comparison.

## Intentional exclusions and local files

Legacy Git history, scratch LiveKit package extraction, obsolete SDK patches,
crash logs, generated binaries and dependency trees are excluded. The active
LiveKit guards are maintained in the voice-bridge postinstall script. Private
settings, dotenv files, invite stores, fonts,
game map caches and optional chart/globe images remain ignored local files.
The migration retained the owner's local configuration and assets separately.

Existing uncommitted bridge-runtime README/start-script edits in the new checkout
were left untouched. The two legacy uncommitted wall-map source edits remain in
legacy; their behavior was integrated into the new implementation without
reverting its TypeScript fixes.

## Verification

- Web typecheck and production build.
- 120 web tests with local textures installed.
- Source-only temporary checkout: 119 passed, one optional installed-image check
  skipped. Missing image files no longer break a fresh clone's test suite.
- Actual map component in Edge at 1600x600 and 650x1000: map viewport equals slot
  frame dimensions; terrain/overlay aspect mode matches; desk keeps `meet`.
- System schematic in Edge with a mocked session manifest and real PNG bytes:
  session terrain requested and rendered, with no page errors. This is fixture
  evidence, not an in-game terrain publication check.

The remaining migration gate is a real KSP voice and telemetry session before
archiving the legacy repository.
