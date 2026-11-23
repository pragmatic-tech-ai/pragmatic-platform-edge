import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One `packages` entry of package-lock.json (the fields the engine check reads). */
export type LockEntry = { Path: string; Dev: boolean }

/** The repository's manifest and its lock file: what is declared, and which installed packages are dev-only. */
export class InstalledPackages
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    private static readonly PackageJson = 'package.json'
    private static readonly PackageLock = 'package-lock.json'
    private static readonly NodeModulesSegment = 'node_modules/'
    private static readonly PathSeparator = '/'
    private static readonly Utf8 = 'utf8'

    /** The dependency names the repository's package.json declares, in every dependency field. */
    public static Declared(): string[]
    {
        const manifest = InstalledPackages.Read(InstalledPackages.PackageJson) as Record<string, Record<string, string> | undefined>
        return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
            .flatMap(field => Object.keys(field ?? {}))
    }

    /** The names the repository's `dependencies` declare (what the image's `npm prune --omit=dev` keeps). */
    public static DeclaredForProduction(): string[]
    {
        const manifest = InstalledPackages.Read(InstalledPackages.PackageJson) as { dependencies?: Record<string, string> }
        return Object.keys(manifest.dependencies ?? {})
    }

    /** Every lock entry that installs the named package (any nesting), with npm's `dev` flag: a `dev` package is one
     *  only devDependencies need, which `npm prune --omit=dev` removes. */
    public static LockEntriesOf(name: string): LockEntry[]
    {
        const I = InstalledPackages
        const lock = I.Read(I.PackageLock) as { packages: Record<string, { dev?: boolean }> }
        return Object.entries(lock.packages)
            .filter(([path]) => path === I.NodeModulesSegment + name || path.endsWith(I.PathSeparator + I.NodeModulesSegment + name))
            .map(([path, entry]) => ({ Path: path, Dev: entry.dev === true }))
    }

    private static Read(file: string): unknown
    {
        return JSON.parse(readFileSync(join(InstalledPackages.RepoRoot, file), InstalledPackages.Utf8))
    }
}
