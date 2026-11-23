import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { AuditThrottle } from '@pragmatic-tech-ai/pragmatic-platform-link'

/** One hit's answer: allowed, or refused for `RetryAfterSeconds`. */
export class RateDecision
{
    private static readonly MsPerSecond = 1000

    public constructor(public readonly Allowed: boolean, private readonly retryAfterMs: number)
    {
    }

    /** Whole seconds until a call may pass again (at least 1). */
    public RetryAfterSeconds(): number
    {
        return Math.max(1, Math.ceil(this.retryAfterMs / RateDecision.MsPerSecond))
    }
}

export interface CustomerApiRateLimitOptions
{
    PerTokenPerMinute?: number
    PerAddressPerMinute?: number
    /** Keys each throttle holds at most (oldest evicted first). */
    MaxKeys?: number
    Now?: () => number
    /** The throttles themselves (tests observe the keys through them). */
    TokenThrottle?: AuditThrottle
    AddressThrottle?: AuditThrottle
}

/**
 * The customer API's limits at the edge (D4 Ledger: edge rate limit): `PerTokenPerMinute` calls per customer session,
 * keyed by the SHA-256 of its bearer (never the bearer), and `PerAddressPerMinute` per client address (an IPv6 address by
 * its /64, an IPv4-mapped one as its IPv4 address). Each is pragmatic-platform-link's AuditThrottle: a fixed one-minute
 * window from a key's first call; the call past the limit locks the key for one minute (Retry-After counts that down).
 * Fixed windows let a key spend its limit at the end of one window and again at the start of the next (a 2x burst at
 * the boundary); accepted for the MVP. In memory, one edge; at most `MaxKeys` keys per throttle, oldest evicted first.
 */
export class CustomerApiRateLimit
{
    public static readonly DefaultPerTokenPerMinute = 60
    public static readonly DefaultPerAddressPerMinute = 600
    public static readonly DefaultMaxKeys = 10000
    public static readonly WindowMs = 60_000
    private static readonly HashAlgorithm = 'sha256'
    private static readonly HashEncoding = 'base64url'
    private static readonly MappedV4Prefix = '::ffff:'
    private static readonly V6Groups = 8
    private static readonly V6PrefixGroups = 4
    private static readonly GroupSeparator = ':'
    private static readonly Elision = '::'
    private static readonly ZoneSeparator = '%'
    private static readonly ZeroGroup = '0'
    private static readonly PrefixSuffix = '::/64'
    private static readonly V4Family = 4
    private static readonly V6Family = 6
    private static readonly HexRadix = 16

    private readonly tokens: AuditThrottle
    private readonly addresses: AuditThrottle

    public constructor(options: CustomerApiRateLimitOptions = {})
    {
        const R = CustomerApiRateLimit
        const now = options.Now ?? (() => Date.now())
        const maxKeys = options.MaxKeys ?? R.DefaultMaxKeys
        this.tokens = options.TokenThrottle ?? new AuditThrottle({ maxHits: options.PerTokenPerMinute ?? R.DefaultPerTokenPerMinute, windowMs: R.WindowMs, lockoutMs: R.WindowMs, maxKeys, now })
        this.addresses = options.AddressThrottle ?? new AuditThrottle({ maxHits: options.PerAddressPerMinute ?? R.DefaultPerAddressPerMinute, windowMs: R.WindowMs, lockoutMs: R.WindowMs, maxKeys, now })
    }

    /** The key a bearer is counted under: its SHA-256. */
    public static TokenKey(token: string): string
    {
        return createHash(CustomerApiRateLimit.HashAlgorithm).update(token).digest(CustomerApiRateLimit.HashEncoding)
    }

    /** The key an address is counted under: IPv4 as is (IPv4-mapped IPv6 folded to it), IPv6 by its /64. */
    public static AddressKey(address: string): string
    {
        const R = CustomerApiRateLimit
        const lower = address.toLowerCase()
        if (lower.startsWith(R.MappedV4Prefix) && isIP(lower.slice(R.MappedV4Prefix.length)) === R.V4Family)
        {
            return lower.slice(R.MappedV4Prefix.length)
        }
        if (isIP(lower) !== R.V6Family)
        {
            return lower
        }
        const groups = R.Expand(lower.split(R.ZoneSeparator)[0] as string)
        return groups.slice(0, R.V6PrefixGroups).map(group => parseInt(group, R.HexRadix).toString(R.HexRadix)).join(R.GroupSeparator) + R.PrefixSuffix
    }

    public HitToken(token: string): RateDecision
    {
        return CustomerApiRateLimit.Hit(this.tokens, CustomerApiRateLimit.TokenKey(token))
    }

    public HitAddress(address: string): RateDecision
    {
        return CustomerApiRateLimit.Hit(this.addresses, CustomerApiRateLimit.AddressKey(address))
    }

    /** A call is counted, and refused when it is past the limit (the throttle locks on the hit that exceeds it). */
    private static Hit(throttle: AuditThrottle, key: string): RateDecision
    {
        const before = throttle.CheckAllowed(key)
        if (!before.allowed)
        {
            return new RateDecision(false, before.retryAfterMs)
        }
        throttle.RecordHit(key)
        const after = throttle.CheckAllowed(key)
        return new RateDecision(after.allowed, after.retryAfterMs)
    }

    /** The eight groups of an IPv6 address (no embedded IPv4 beyond the mapped form handled above). */
    private static Expand(address: string): string[]
    {
        const R = CustomerApiRateLimit
        const [head, tail] = address.includes(R.Elision) ? address.split(R.Elision) as [string, string] : [address, undefined]
        const left = head === '' ? [] : head.split(R.GroupSeparator)
        if (tail === undefined)
        {
            return left
        }
        const right = tail === '' ? [] : tail.split(R.GroupSeparator)
        const zeros = new Array<string>(R.V6Groups - left.length - right.length).fill(R.ZeroGroup)
        return [...left, ...zeros, ...right]
    }
}
