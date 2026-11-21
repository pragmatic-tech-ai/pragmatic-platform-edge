import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository's manifest and every package installed under its node_modules (nested copies included). */
export class InstalledPackages
{
    public static readonly RepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    private static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly ScopePrefix = '@'
    private static readonly HiddenPrefix = '.'
    private static readonly Utf8 = 'utf8'

    /** The dependency names the repository's package.json declares, in every dependency field. */
    public static Declared(): string[]
    {
        const I = InstalledPackages
        const manifest = JSON.parse(readFileSync(join(I.RepoRoot, I.PackageJson), I.Utf8)) as Record<string, Record<string, string> | undefined>
        return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
            .flatMap(field => Object.keys(field ?? {}))
    }

    /** The install directory of every installed copy of the named package. */
    public static CopiesOf(name: string): string[]
    {
        const copies: string[] = []
        InstalledPackages.Walk(join(InstalledPackages.RepoRoot, InstalledPackages.NodeModules), name, copies)
        return copies
    }

    private static Walk(modules: string, name: string, copies: string[]): void
    {
        const I = InstalledPackages
        if (!existsSync(modules))
        {
            return
        }
        for (const entry of readdirSync(modules, { withFileTypes: true }))
        {
            if (entry.name.startsWith(I.HiddenPrefix) || !(entry.isDirectory() || entry.isSymbolicLink()))
            {
                continue
            }
            const dirs = entry.name.startsWith(I.ScopePrefix)
                ? readdirSync(join(modules, entry.name)).map(child => join(modules, entry.name, child))
                : [join(modules, entry.name)]
            for (const dir of dirs)
            {
                I.Visit(dir, name, copies)
            }
        }
    }

    private static Visit(dir: string, name: string, copies: string[]): void
    {
        const I = InstalledPackages
        const manifest = join(dir, I.PackageJson)
        if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, I.Utf8)) as { name?: string }).name === name)
        {
            copies.push(dir)
        }
        I.Walk(join(dir, I.NodeModules), name, copies)
    }
}
