import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstalledPackages } from './installed-packages.js'

/**
 * The edge carries no TODL engine and no Mural: neither is declared, and neither is installed (the app-host and
 * realm-adapters peers on them are not installed, `legacy-peer-deps` in .npmrc and the Dockerfile's deps stage).
 */
class EnginePackages
{
    public static readonly Names: readonly string[] = ['@pragmatic-tech-ai/todl', '@pragmatic-tech-ai/mural']
}

describe('no engine packages', () =>
{
    it('package.json declares neither todl nor mural', () =>
    {
        assert.deepEqual(InstalledPackages.Declared().filter(name => EnginePackages.Names.includes(name)), [])
    })

    it('the installed tree holds neither todl nor mural', () =>
    {
        assert.deepEqual(EnginePackages.Names.flatMap(name => InstalledPackages.CopiesOf(name)), [])
    })
})
