# pragmatic-platform-edge

The keyless public platform edge: one container image, `ghcr.io/pragmatic-tech-ai/pragmatic-platform-edge`. It serves
the hive agent channel, desktop discovery and `/healthz` on port 7100 and answers every call through the platform admin
console's internal API; it opens no data root, key, registry or master key of its own. Seeded from pragmatic-server
(dev-kit plan A3, the container split); its component descriptor and digest are the ones pragmatic-server pinned.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PRAGMATIC_AGENT_CHANNEL_PORT` | `7100` (the image sets it) | Port of the public agent channel |
| `PRAGMATIC_AGENT_CHANNEL_BIND` | `0.0.0.0` (the image sets it) | Address of the public agent channel (an IP address) |
| `PRAGMATIC_EDGE_ADMIN_URL` | required | The http(s) URL of the platform admin console's internal API |
| `PRAGMATIC_INTERNAL_API_SECRET_FILE` | required | A mounted file holding the internal API's shared secret |
| `PRAGMATIC_EDGE_TRUSTED_PROXY` | `false` | Whether a trusted proxy sits in front (`x-forwarded-for` is then the client) |

The image's entry point is `node dist/bin/pragmatic-platform-edged.js` under `/workspace/pragmatic-platform-edge`, run
as user 10001; no command is needed.

## Develop

Packages come from GitHub Packages (`.npmrc`, token in `NODE_AUTH_TOKEN`). The edge reaches no TODL engine and no Mural:
`legacy-peer-deps` keeps the TODL peers of pragmatic-app-host and pragmatic-realm-adapters out of the tree (the
Dockerfile's deps stage repeats it), and `src/tests/no-engine-packages.test.ts` holds it there.

```
npm ci
npm run build
npm test
npx tsc --noEmit
npx pragmatic-closure-check
```

The Dockerfile, bake file, tsconfigs and workflows are rendered by `pragmatic-container-template` (pragmatic-release-toolkit);
the one hand edit is the deps stage's `NPM_CONFIG_LEGACY_PEER_DEPS`. CI runs pragmatic-shared's reusable
`container-ci.yml` (amd64 and arm64); a `v<semver>` tag equal to `package.json`'s version runs `container-release.yml`.

## License

Apache-2.0.
