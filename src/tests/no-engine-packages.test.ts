import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstalledPackages } from './installed-packages.js'

/**
 * The edge carries no TODL engine, no todl-runtime and no Mural: none is declared and none is installed. Its shared
 * packages (pragmatic-platform-link, pragmatic-component) declare no peer, so a plain install (no `legacy-peer-deps`)
 * keeps them out.
 */
class EnginePackages
{
    public static readonly Names: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/todl-runtime', '@pragmatic-tech-ai/mural']
}

describe('no engine packages', () =>
{
    it('package.json declares none of todl, todl-runtime and mural', () =>
    {
        assert.deepEqual(InstalledPackages.Declared().filter(name => EnginePackages.Names.includes(name)), [])
    })

    it('the installed tree holds none of them', () =>
    {
        assert.deepEqual(EnginePackages.Names.flatMap(name => InstalledPackages.CopiesOf(name)), [])
    })
})
