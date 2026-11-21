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
 * The descriptor the image carries is the one pragmatic-server's release signed: the digest pinned in its vendored set
 * (`admin/control-plane/descriptors/digests.json` at the seed commit) and the golden fixture copied with it.
 */
class DescriptorGoldenFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(DescriptorGoldenFixture.Here, 'fixtures', 'pragmatic-platform-edge.component.json')
    public static readonly PackageJson = join(DescriptorGoldenFixture.Here, '..', '..', 'package.json')
    /** pragmatic-server@2a2e8138 `admin/control-plane/descriptors/digests.json`, entry `pragmatic-platform-edge`. */
    public static readonly ServerPinnedDigest = 'sha256:f8e6ed26594d13a07d6a35f48ad93bcdbede400637a431f9c16a8a3305a4ad8c'
    public static readonly Utf8 = 'utf8'

    public static PackageVersion(): string
    {
        const F = DescriptorGoldenFixture
        return (JSON.parse(readFileSync(F.PackageJson, F.Utf8)) as { version: string }).version
    }
}

describe('descriptor golden', () =>
{
    it('the release module\'s descriptor has the digest pragmatic-server pinned', () =>
    {
        const F = DescriptorGoldenFixture
        const descriptor = Components.Of(ReleaseApp.PlatformEdge)
        ComponentGolden.Check(descriptor, F.Golden, F.ServerPinnedDigest)
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
