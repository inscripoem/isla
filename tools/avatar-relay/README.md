# Avatar relay

A local-only relay that turns a VTube Studio-style avatar source into the
console's avatar wire contract. It is a Node process that is never imported by
the browser graph; the console connects to it over a local WebSocket.

## Commands

```sh
pnpm relay:avatar                       # source defaults to none
pnpm relay:avatar --source synthetic    # emit the local transparent fixture
pnpm relay:avatar --port 4320 --fps 15
```

- `--port <number>` defaults to `4320`; `0` asks the OS for a free port.
- `--source none|synthetic|ndi` defaults to `none`. Only `synthetic` emits
  frames; `ndi` is unimplemented and exits with code `2`.
- `--fps <number>` defaults to `15`.

## Network policy

- Binds `127.0.0.1` only; it is never reachable off the machine.
- A WebSocket upgrade requires `Origin` to be absent (a local CLI) or to name
  `localhost`, `127.0.0.1` or `[::1]`/`::1`. Any other origin, including the
  literal `null`, is rejected with HTTP `403`.
- A request to any path other than `/avatar` is rejected with HTTP `404`.
- At most 4 clients are served; further clients are closed on connect.
- Frames are dropped for a client whose send buffer is already above 8 MiB.

## Browser configuration

Set the relay URL in `.env`:

```sh
VITE_AVATAR_RELAY_URL=ws://127.0.0.1:4320/avatar
```

A blank value keeps the stage unavailable. `http`/`https` URLs are mapped to
`ws`/`wss`, and a bare `host:port` defaults to the `/avatar` path.

## Wire contract

- Text `avatar.status`: `protocolVersion` `0.1`, `kind` `avatar.status`,
  `source` (`none`/`synthetic`/`ndi`), `fps` and `lastFrameAt`.
- Binary `avatar.frame`: an 8-byte header (magic `AV`, version `1`, format `1`
  for WebP with alpha, big-endian `uint16` width and height) followed by the
  payload. Frames are limited to 2 MiB with dimensions in `1..1920` px.

## Honesty note

Synthetic frames are a local observation fixture only. They are not VTube
Studio evidence and do not demonstrate a live avatar pipeline.
