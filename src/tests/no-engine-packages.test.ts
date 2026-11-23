import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstalledPackages } from './installed-packages.js'

/**
 * The edge's image carries no TODL engine, no todl-runtime and no Mural: none is a production dependency and the
 * production tree (what `npm prune --omit=dev` leaves in the image) reaches none. Its runtime packages
 * (pragmatic-platform-link, pragmatic-component) declare no peer. The customer-API contracts are devDependencies only
 * (the wire parity test): their app-host peers bring the engine into the dev tree, never into the image.
 */
class EnginePackages
{
    public static readonly Names: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
    public static readonly ContractNames: readonly string[] = ['@pragmatic-tech-ai/pragmatic-customer-api-contract', '@pragmatic-tech-ai/pragmatic-entitlements-contract', '@pragmatic-tech-ai/pragmatic-app-host']
}

describe('no engine packages', () =>
{
    it('package.json declares none of todl, todl-runtime and mural', () =>
    {
        assert.deepEqual(InstalledPackages.Declared().filter(name => EnginePackages.Names.includes(name)), [])
    })

    it('the production tree reaches none of them', () =>
    {
        const production = InstalledPackages.Production()
        assert.ok(production.has('@pragmatic-tech-ai/pragmatic-platform-link'))
        assert.ok(production.has('@pragmatic-tech-ai/pragmatic-component'))
        assert.deepEqual(EnginePackages.Names.filter(name => production.has(name)), [])
    })

    it('the walk sees peers: from the customer-API contract it reaches the engine', () =>
    {
        assert.ok(InstalledPackages.Reachable(['@pragmatic-tech-ai/pragmatic-customer-api-contract']).has('@pragmatic-tech-ai/todl'))
    })

    it('the production tree holds no customer-API contract or app-host (their peers are the engine)', () =>
    {
        const production = InstalledPackages.Production()
        assert.deepEqual(EnginePackages.ContractNames.filter(name => production.has(name)), [])
    })
})
