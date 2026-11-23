import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { Components } from '../release-components.js'
import { PlatformEdgeComponent } from '../platform-edge-component.js'
import { ComponentGolden } from './component-golden.js'

/**
 * The descriptor the image carries: the golden fixture and its pinned digest (first pinned from pragmatic-server's
 * vendored set at the seed commit; D4 added the `customerApi` option). A changed descriptor is a deliberate edit of both.
 */
class DescriptorGoldenFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(DescriptorGoldenFixture.Here, 'fixtures', 'pragmatic-platform-edge.component.json')
    public static readonly PackageJson = join(DescriptorGoldenFixture.Here, '..', '..', 'package.json')
    /** The descriptor's content digest (D4: with the customer API relay option). */
    public static readonly PinnedDigest = 'sha256:84f51ab1dcd02bc65f110c2db47083639f1b950c0f0bcc2f1169eac0e63d3cf6'
    public static readonly Utf8 = 'utf8'

    public static PackageVersion(): string
    {
        const F = DescriptorGoldenFixture
        return (JSON.parse(readFileSync(F.PackageJson, F.Utf8)) as { version: string }).version
    }
}

describe('descriptor golden', () =>
{
    it('the release module\'s descriptor has the pinned digest', () =>
    {
        const F = DescriptorGoldenFixture
        const descriptor = Components.Of(ReleaseApp.PlatformEdge)
        ComponentGolden.Check(descriptor, F.Golden, F.PinnedDigest)
    })

    it('the release module holds exactly this repository\'s component', () =>
    {
        const all = Components.All()
        assert.deepEqual(all.map(([app]) => app), [ReleaseApp.PlatformEdge])
        assert.throws(() => Components.Of(ReleaseApp.PlatformAdmin))
    })

    it('the descriptor version is the package version', () =>
    {
        assert.equal(PlatformEdgeComponent.Version, DescriptorGoldenFixture.PackageVersion())
    })
})
