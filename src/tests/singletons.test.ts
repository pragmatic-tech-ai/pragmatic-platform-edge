import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InstalledPackages } from './installed-packages.js'

/** A second installed copy of todl-runtime would fail `instanceof` across the copies (A3 Review Focus 1). */
class SingletonPackages
{
    public static readonly TodlRuntime = '@pragmatic-tech-ai/todl-runtime'
}

describe('singletons', () =>
{
    it('installs exactly one copy of todl-runtime', () =>
    {
        assert.equal(InstalledPackages.CopiesOf(SingletonPackages.TodlRuntime).length, 1)
    })
})
