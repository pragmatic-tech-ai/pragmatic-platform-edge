# pragmatic-platform-edge architecture

- **`PlatformEdgeBin`** (`src/bin/pragmatic-platform-edged.ts`) - the image's entry: `EdgeComposition.Compose(env)`, listen
  on the composed bind and port, install `EdgeShutdown`, print the listening line; a start failure prints the stack and
  exits 1. No `PRAGMATIC_CONTROL_PLANE_ROLE`: the platform admin console's `server.ts` refuses role `edge`.
- **`EdgeComposition`** (`src/edge-composition.ts`) - reads the five variables of the descriptor (`PlatformEdgeComponent`),
  builds an `InternalApiClient` over pragmatic-platform-link's `InternalApiLink` (the admin URL and the secret file; the
  bearer is pragmatic-component's `InternalApiCredential`) and the two remote backends, and returns the `EdgeHost`.
  `EdgeShutdown` closes the listener on SIGTERM / SIGINT.
- **`EdgeHost`** (`src/edge-host.ts`) - one HTTP listener: pragmatic-platform-link's `AgentChannelHost` (the hive agent
  channel) and `DesktopDiscoveryEndpoint`, `PlaneHttp` for the shared HTTP handling, and `/healthz`.
  `EdgeClientAddress` is the address the throttles key on: the socket peer, or the last `x-forwarded-for` hop behind a
  trusted proxy.
- **`RemoteAgentChannelBackend`**, **`RemoteDesktopDiscoveryBackend`** (`src/remote-*.ts`) - the edge side of the internal
  API: every request is posted verbatim to admin (`InternalApiRoutes.Agent` / `Discover`); admin unreachable, slow or
  answering anything but a well-formed 200 is a 503 `{ error: 'unavailable' }`, never admin's text.
- **`PlatformEdgeComponent`** (`src/platform-edge-component.ts`) - the component descriptor (name
  `pragmatic-platform-edge`, version = package version, port `agent-channel` 7100, health `/healthz`);
  `src/release-components.ts` exports it as `Components` for `pragmatic-component-descriptors`, which writes the image's
  `/pragmatic/component.json` and its digest label. `src/tests/descriptor-golden.test.ts` pins the digest pragmatic-server
  signed.
- **Dependencies** - pragmatic-platform-link and the one package it brings (pragmatic-component); neither declares a
  peer, so the tree holds no TODL engine, no todl-runtime and no Mural (`no-engine-packages.test.ts`). `closure.json` lists what the image copies; `pragmatic-closure-check`
  compares it with what the entry reaches and the Dockerfile copies.
