import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A package's manifest fields the production walk reads. */
type PackageManifest = { name?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }

/** The repository's manifest and the installed packages its production dependencies reach. */
export class InstalledPackages
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    private static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly Utf8 = 'utf8'

    /** The dependency names the repository's package.json declares, in every dependency field. */
    public static Declared(): string[]
    {
        const I = InstalledPackages
        const manifest = JSON.parse(readFileSync(join(I.RepoRoot, I.PackageJson), I.Utf8)) as Record<string, Record<string, string> | undefined>
        return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
            .flatMap(field => Object.keys(field ?? {}))
    }

    /** The names the repository's `dependencies` declare (what the image's `npm prune --omit=dev` keeps). */
    public static DeclaredForProduction(): string[]
    {
        return Object.keys(InstalledPackages.ManifestOf(InstalledPackages.RepoRoot)?.dependencies ?? {})
    }

    /**
     * The names of every installed package the production tree reaches: from the repository's `dependencies`, each
     * package's `dependencies`, `optionalDependencies` and non-optional `peerDependencies` (npm installs those), resolved
     * the way Node does (the nearest node_modules up the tree). This is what the image carries.
     */
    public static Production(): Set<string>
    {
        return InstalledPackages.Reachable(InstalledPackages.DeclaredForProduction())
    }

    /** The names of every installed package reachable from the named top-level packages (the walk Production makes). */
    public static Reachable(roots: readonly string[]): Set<string>
    {
        const I = InstalledPackages
        const names = new Set<string>()
        const visited = new Set<string>()
        const queue: Array<[string, string]> = roots.map(name => [I.RepoRoot, name])
        while (queue.length > 0)
        {
            const [from, name] = queue.shift() as [string, string]
            const dir = I.Resolve(from, name)
            if (dir === undefined || visited.has(dir))
            {
                continue
            }
            visited.add(dir)
            const manifest = I.ManifestOf(dir)
            names.add(manifest?.name ?? name)
            for (const next of I.RuntimeNeeds(manifest))
            {
                queue.push([dir, next])
            }
        }
        return names
    }

    private static RuntimeNeeds(manifest: PackageManifest | undefined): string[]
    {
        const peers = Object.keys(manifest?.peerDependencies ?? {}).filter(peer => manifest?.peerDependenciesMeta?.[peer]?.optional !== true)
        return [...Object.keys(manifest?.dependencies ?? {}), ...Object.keys(manifest?.optionalDependencies ?? {}), ...peers]
    }

    /** Node's lookup: `<dir>/node_modules/<name>` from `from` up to the repository root. */
    private static Resolve(from: string, name: string): string | undefined
    {
        const I = InstalledPackages
        let dir = from
        while (dir === I.RepoRoot || dir.startsWith(I.RepoRoot + sep))
        {
            const candidate = join(dir, I.NodeModules, name)
            if (existsSync(join(candidate, I.PackageJson)))
            {
                return candidate
            }
            const parent = dirname(dir)
            if (parent === dir)
            {
                break
            }
            dir = parent
        }
        return undefined
    }

    private static ManifestOf(dir: string): PackageManifest | undefined
    {
        const manifest = join(dir, InstalledPackages.PackageJson)
        return existsSync(manifest) ? JSON.parse(readFileSync(manifest, InstalledPackages.Utf8)) as PackageManifest : undefined
    }
}
