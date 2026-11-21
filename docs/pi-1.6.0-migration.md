# Pi 1.6.0 migration

- Rail baseline: `dev` at `541a6c5af1a109928edc13ce44a6ffb4022164a4`.
- Pi: [v1.6.0](https://github.com/earendil-works/pi/releases/tag/v1.6.0), `faac585884ae2c013a6b1400f3e9e77f10b34bac`. All four Pi dev dependencies are pinned to the same version. Start a new 1.6.0 process; `/reload` does not replace Pi itself.
- The [1.5.2 migration](pi-1.5.2-migration.md) remains an earlier verification record.

## Behavior

- Pi owns built-in commands and system/resource output again. The shared Rail gutter still applies; command output has no per-output Rail decoration.
- The Rail `read` card retains its shell and controls, using Pi's collapsed result (including image capability notices). Native transcripts remain independent of the card.
- Hosted search prefers native provider events and keeps the bounded compatibility observation for older custom SSE providers. Display, sources and child counts remain based on observed calls, not tool injection or citations. On a mixed custom stream, the mounted card switches to native data when a public hosted-search call arrives. Text-only public events do not disable legacy capture. The pre-existing case where a Rail WSS overlay claims native events but delegates SSE to a custom stream that ignores them remains out of scope.
- Pi 1.6.0 may reuse read-only render rows. Rail forwards them unchanged or builds its own rows when decorating. Pi owns scroll-only redraws.
- The existing manual keep-alive scheduler retains the live native CacheWarmer on this pinned version. The custom Responses WSS path drops one removed conversion option during continuation item reconstruction. Team scheduling, remote compaction and WSS routing policy are unchanged.

## Verification

Code checkpoint: `002cd6f5493ea428ddc7c7034d617373ea9fb212`. Linux, Node 24.22.3, official Pi npm bundle.

- `PI_OFFLINE=1 PI_TELEMETRY=0 npm run check`: TypeScript passed; 1644 tests passed, one opt-in wall-clock test skipped, no failures.
- `RAIL_KEEP_ALIVE_WALL_CLOCK=1 PI_OFFLINE=1 PI_TELEMETRY=0 node --import tsx --test --test-name-pattern="real wall-clock expiry" tests/core/bundle-keep-alive.test.ts`: the skipped test passed separately.
- Native PTY: startup, session panel, resize, Rail toggle, reload, reopen, and clean exit. Native component tests cover status rows, single-card read expansion, image rendering and warnings. Hosted search and Team tests use the actual Pi runtime with local fixtures, not paid models.
- No live production provider or macOS terminal was tested.
