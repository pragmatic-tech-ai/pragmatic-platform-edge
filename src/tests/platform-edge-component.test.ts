import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PlatformEdgeComponent } from '../platform-edge-component.js'
import { ComponentGolden } from './component-golden.js'
import { ComponentSources } from './component-sources.js'

class PlatformEdgeComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(PlatformEdgeComponentFixture.Here, 'fixtures', 'pragmatic-platform-edge.component.json')
    public static readonly Digest = 'sha256:d964635f1b5bce15328936a6234639e470e8668ca41ad031c6012451fffeda47'
    public static readonly Readers = [['..', 'edge-composition.ts'], ['..', 'bin', 'pragmatic-platform-edged.ts']].map(path => join(PlatformEdgeComponentFixture.Here, ...path))
        .concat([join(dirname(fileURLToPath(import.meta.resolve('@pragmatic-tech-ai/pragmatic-platform-link'))), 'internal-api-link.js')])
    public static readonly Undeclared: readonly string[] = []
}

describe('PlatformEdgeComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(PlatformEdgeComponent.Descriptor(), PlatformEdgeComponentFixture.Golden, PlatformEdgeComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(PlatformEdgeComponent.Descriptor(), PlatformEdgeComponentFixture.Readers, PlatformEdgeComponentFixture.Undeclared)
    })

    it('is named for its release image', () =>
    {
        assert.equal(PlatformEdgeComponent.Descriptor().Name, 'pragmatic-platform-edge')
    })
})
