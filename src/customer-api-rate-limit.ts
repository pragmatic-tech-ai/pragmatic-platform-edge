import { createHash } from 'node:crypto'

/** One hit's answer: allowed, or refused until the window ends. */
export class RateDecision
{
    private static readonly MsPerSecond = 1000

    public constructor(public readonly Allowed: boolean, private readonly retryAfterMs: number)
    {
    }

    /** Whole seconds until the window ends (at least 1). */
    public RetryAfterSeconds(): number
    {
        return Math.max(1, Math.ceil(this.retryAfterMs / RateDecision.MsPerSecond))
    }
}

/** One key's fixed window. */
class RateWindow
{
    public Count = 0

    public constructor(public readonly StartedAt: number)
    {
    }
}

/**
 * The customer API's limits at the edge (D4 Ledger: edge rate limit): `perTokenPerMinute` calls per customer session,
 * keyed by the SHA-256 of its bearer, and `perAddressPerMinute` per client address (the cabinet's server relays every
 * customer from one address, so that one is the loose limit). Fixed one-minute windows, in memory only (one edge in the
 * MVP); a window that has passed is forgotten at the next sweep (one a minute), so memory holds at most two minutes of keys. The bearer
 * itself is never held.
 */
export class CustomerApiRateLimit
{
    public static readonly WindowMs = 60_000
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'base64url'
    private static readonly TokenPrefix = 'token:'
    private static readonly AddressPrefix = 'address:'

    private readonly windows = new Map<string, RateWindow>()
    private nextSweep: number

    public constructor(
        private readonly perTokenPerMinute: number = 60,
        private readonly perAddressPerMinute: number = 600,
        private readonly now: () => number = () => Date.now())
    {
        this.nextSweep = this.now() + CustomerApiRateLimit.WindowMs
    }

    public HitToken(token: string): RateDecision
    {
        const digest = createHash(CustomerApiRateLimit.HashAlgorithm).update(token).digest(CustomerApiRateLimit.HashEncoding)
        return this.Hit(CustomerApiRateLimit.TokenPrefix + digest, this.perTokenPerMinute)
    }

    public HitAddress(address: string): RateDecision
    {
        return this.Hit(CustomerApiRateLimit.AddressPrefix + address, this.perAddressPerMinute)
    }

    /** How many keys are held now (for tests). */
    public get Size(): number
    {
        return this.windows.size
    }

    /** The keys held now (for tests: a bearer appears only as its digest). */
    public Keys(): readonly string[]
    {
        return [...this.windows.keys()]
    }

    private Hit(key: string, limit: number): RateDecision
    {
        const now = this.now()
        this.Sweep(now)
        let window = this.windows.get(key)
        if (window === undefined || now - window.StartedAt >= CustomerApiRateLimit.WindowMs)
        {
            window = new RateWindow(now)
            this.windows.set(key, window)
        }
        const retryAfterMs = window.StartedAt + CustomerApiRateLimit.WindowMs - now
        if (window.Count >= limit)
        {
            return new RateDecision(false, retryAfterMs)
        }
        window.Count++
        return new RateDecision(true, retryAfterMs)
    }

    private Sweep(now: number): void
    {
        if (now < this.nextSweep)
        {
            return
        }
        for (const [key, window] of this.windows)
        {
            if (now - window.StartedAt >= CustomerApiRateLimit.WindowMs)
            {
                this.windows.delete(key)
            }
        }
        this.nextSweep = now + CustomerApiRateLimit.WindowMs
    }
}
