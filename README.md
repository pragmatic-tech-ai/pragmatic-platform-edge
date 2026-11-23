# pragmatic-platform-edge

The keyless public platform edge: one container image, `ghcr.io/pragmatic-tech-ai/pragmatic-platform-edge`. It serves
the hive agent channel, desktop discovery, `/healthz` and (when configured) the customer API (`POST
/api/customer/v1/<operation>`, the personal cabinet's calls with the customer's central-login token) on port 7100, and
answers every call through the platform admin console's internal API; it opens no data root, key, registry or master
key of its own, and never verifies or keeps a customer's token (the console does). Seeded from pragmatic-server (dev-kit
plan A3, the container split).

The customer API: only the seven operations of pragmatic-customer-api-contract, `POST` with a JSON object of at most
16 KiB, are relayed (to the console's `/internal/customer/v1/<operation>`, the customer's bearer moved to
`x-pragmatic-customer-token`); anything else under the prefix is 404, a bigger body 413, a missing bearer 401
`not-signed-in`, the console unreachable 503 `unavailable`. Limits: 60 calls a minute per bearer, 600 per client address
(429 `rate-limited`), in memory.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PRAGMATIC_AGENT_CHANNEL_PORT` | `7100` (the image sets it) | Port of the public agent channel |
| `PRAGMATIC_AGENT_CHANNEL_BIND` | `0.0.0.0` (the image sets it) | Address of the public agent channel (an IP address) |
| `PRAGMATIC_EDGE_ADMIN_URL` | required | The http(s) URL of the platform admin console's internal API |
| `PRAGMATIC_INTERNAL_API_SECRET_FILE` | required | A mounted file holding the internal API's shared secret |
| `PRAGMATIC_EDGE_TRUSTED_PROXY` | `false` | Whether a trusted proxy sits in front (`x-forwarded-for` is then the client) |
| `PRAGMATIC_EDGE_CUSTOMER_API_SECRET_FILE` | unset (customer API off: the prefix is 404) | A mounted file holding the customer-API link's shared secret (at least 32 bytes; the console's `PRAGMATIC_ADMIN_CUSTOMER_API_SECRET_FILE`) |

The image's entry point is `node dist/bin/pragmatic-platform-edged.js` under `/workspace/pragmatic-platform-edge`, run
as user 10001; no command is needed.

## Develop

Packages come from GitHub Packages (`.npmrc`, token in `NODE_AUTH_TOKEN`). The edge reaches no TODL engine, no
todl-runtime and no Mural at runtime: its production packages declare no peer, and `src/tests/no-engine-packages.test.ts`
holds the production tree (what the image keeps) that way. The customer-API contracts are devDependencies only:
`src/tests/customer-api-parity.test.ts` pins the edge's copy of their wire to them and runs a round trip through the
contract's client and console routes.

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
