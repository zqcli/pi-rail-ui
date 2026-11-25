# Pi 1.6.1 migration

- Rail base: `fc616865b5704b4a9c99eab966c67330d1b487a9` (`dev`).
- Pi: [v1.6.1](https://github.com/earendil-works/pi/releases/tag/v1.6.1), `ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe`. The four Pi dev dependencies and lockfile are updated together. Restart Pi after upgrading.

## Compatibility

- The native Codex adapter now sends the initial selected reasoning effort directly. The native Responses serializer encodes replayed tool calls as completed, which fixes a Codex WebSocket reconnect mismatch. Rail's custom Responses WebSocket uses Pi's shared request assembler and replay serializer; Rail does not change its route, cache, or effort policy.
- Pi owns the four switches under `/settings → Notices` and converts the old shared setting. Rail does not call the removed settings API or duplicate the switches.
- Expanded `!bash` output keeps Pi's own full-output warning. The Rail render cache also keys on the new failure reason so the warning cannot become stale.
- The existing version-gated manual cache warmer targets the new pinned runtime. No Team scheduling, card design, or command behavior was changed.

The [1.6.0 migration](pi-1.6.0-migration.md) remains the earlier verification record.

## Verification

Linux, Node 24.22.3, official Pi npm bundle:

- `PI_OFFLINE=1 PI_TELEMETRY=0 npm run check`: typecheck passed, 1,647 tests passed, zero failures, one opt-in real-clock test skipped.
- `RAIL_KEEP_ALIVE_WALL_CLOCK=1 PI_OFFLINE=1 PI_TELEMETRY=0 node --import tsx --test --test-name-pattern='real wall-clock expiry' tests/core/bundle-keep-alive.test.ts`: the opt-in test passed separately.
- Terminal smoke: start, session overlay, resize, Rail off/on, reload, reopen, clean exit.
- Payload checks intercepted the initial native Astra max request and a Rail request with tool replay before transport. Local fixtures also covered actual Pi, Team RPC, native loading and cache warming. No live gateway, paid-model behavior or macOS terminal was tested.
