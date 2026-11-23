import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstalledPackages } from './installed-packages.js'

/**
 * The edge's image carries no TODL engine, no todl-runtime and no Mural. None is a production dependency, and in the
 * lock every copy of them, of pragmatic-app-host and of the two customer-API contracts (whose peers are the engine) is
 * `dev`: only the devDependencies (the wire parity test) need them, so the image's `npm prune --omit=dev` removes them.
 * The runtime packages (pragmatic-platform-link, pragmatic-component) declare no peer.
 */
class EnginePackages
{
    public static readonly Engine: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    public static readonly DevOnly: readonly string[] = [...EnginePackages.Engine, '@pragmatic-tech-ai/pragmatic-app-host', '@pragmatic-tech-ai/pragmatic-customer-api-contract', '@pragmatic-tech-ai/pragmatic-entitlements-contract']
    public static readonly Runtime: readonly string[] = ['@pragmatic-tech-ai/pragmatic-platform-link', '@pragmatic-tech-ai/pragmatic-component']
}

describe('no engine packages in the image', () =>
{
    it('package.json declares none of todl, todl-runtime and mural', () =>
    {
        assert.deepEqual(InstalledPackages.Declared().filter(name => EnginePackages.Engine.includes(name)), [])
    })

    it('the production dependencies are the runtime packages only', () =>
    {
        assert.deepEqual(InstalledPackages.DeclaredForProduction().sort(), [...EnginePackages.Runtime].sort())
    })

    it('every lock entry of the engine, app-host and the contracts is dev-only', () =>
    {
        assert.ok(InstalledPackages.LockEntriesOf('@pragmatic-tech-ai/todl').length > 0, 'the dev tree installs todl, so the check is real')
        const kept = EnginePackages.DevOnly.flatMap(name => InstalledPackages.LockEntriesOf(name)).filter(entry => !entry.Dev)
        assert.deepEqual(kept, [])
    })

    it('the runtime packages are not dev-only', () =>
    {
        for (const name of EnginePackages.Runtime)
        {
            const entries = InstalledPackages.LockEntriesOf(name)
            assert.ok(entries.length > 0 && entries.every(entry => !entry.Dev), name)
        }
    })
})
