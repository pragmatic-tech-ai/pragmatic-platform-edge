import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgentExchangeLink, AgentExchangeRefusal } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AuditThrottle, InternalApiRoutes, InternalApiUnavailableError, PlaneHttp, type InternalApiRelayReply } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiRateLimit, RateDecision } from './customer-api-rate-limit.js'

/** What the front relays to: the platform admin console's internal listener (InternalApiClient). */
export interface IAgentExchangeRelay
{
    Relay(path: string, body: Buffer, contentType: string, maxReplyBytes: number): Promise<InternalApiRelayReply>
}

export interface AgentExchangeRateLimitOptions
{
    PerAddressPerMinute?: number
    MaxKeys?: number
    Now?: () => number
}

/**
 * The exchange's limit at the edge: `PerAddressPerMinute` messages per client address (an IPv6 address by its /64, as
 * the customer API counts addresses), so no client can flood the console's nonce ledger or its enrolment queue. A hive
 * reports every 30 seconds; the default leaves room for many hives behind one address. In memory, one edge; a fixed
 * one-minute window, the call past the limit locks the address for a minute.
 */
export class AgentExchangeRateLimit
{
    public static readonly DefaultPerAddressPerMinute = 300
    public static readonly DefaultMaxKeys = 10000
    public static readonly WindowMs = 60_000

    private readonly addresses: AuditThrottle

    public constructor(options: AgentExchangeRateLimitOptions = {})
    {
        const R = AgentExchangeRateLimit
        this.addresses = new AuditThrottle({
            maxHits: options.PerAddressPerMinute ?? R.DefaultPerAddressPerMinute, windowMs: R.WindowMs, lockoutMs: R.WindowMs,
            maxKeys: options.MaxKeys ?? R.DefaultMaxKeys, now: options.Now ?? (() => Date.now()),
        })
    }

    public HitAddress(address: string): RateDecision
    {
        const key = CustomerApiRateLimit.AddressKey(address)
        const before = this.addresses.CheckAllowed(key)
        if (!before.allowed)
        {
            return new RateDecision(false, before.retryAfterMs)
        }
        this.addresses.RecordHit(key)
        const after = this.addresses.CheckAllowed(key)
        return new RateDecision(after.allowed, after.retryAfterMs)
    }
}

/** What reading the agent's body found. */
enum ExchangeBody
{
    Read = 'read',
    TooLarge = 'too-large',
    Dropped = 'dropped',
}

class ExchangeBodyRead
{
    public constructor(public readonly Outcome: ExchangeBody, public readonly Bytes: Buffer)
    {
    }
}

/**
 * The edge's public face of the signed agent exchange (C3.3, `POST /agent/v2/exchange`): the body (at most 1 MiB) is
 * relayed verbatim to the platform admin console's internal `POST /internal/v2/agent/exchange` under the internal
 * bearer, and the console's status and bytes come back as they are (200 envelope, 204, or a refusal code). The edge is
 * keyless: it never parses, verifies or logs an envelope. Another method is 405; over 1 MiB is 413 before anything is
 * relayed; the console unreachable, or refusing the link itself, is 503 `unavailable` (the platform's fault). Each
 * message first spends its client address's budget (AgentExchangeRateLimit): past it, 503 `unavailable` with Retry-After.
 */
export class AgentExchangeFront
{
    private static readonly QuerySeparator = '?'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly ContentTypeHeader = 'Content-Type'
    private static readonly AllowHeader = 'Allow'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly StatusMethodNotAllowed = 405
    private static readonly StatusUnauthorized = 401
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly FallbackErrorName = 'Error'
    /** The console's answer is an envelope (at most 1 MiB) or a short refusal. */
    private static readonly MaxReplyBytes = AgentExchangeLink.BodyLimit + 65536
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[agent-exchange]'
    private static readonly Utf8 = 'utf8'
    private static readonly LinkRefusedMessage = 'the console refused the internal-API link bearer (secret files differ?)'

    public constructor(private readonly admin: IAgentExchangeRelay, private readonly limit: AgentExchangeRateLimit = new AgentExchangeRateLimit(), private readonly log: (line: string) => void = line => console.error(line))
    {
    }

    /** Whether the request is the exchange's (and so the front's to answer). */
    public static Owns(url: string): boolean
    {
        return url.split(AgentExchangeFront.QuerySeparator)[0] === AgentExchangeLink.PublicPath
    }

    /** Answers the exchange; never throws. */
    public async Handle(req: IncomingMessage, res: ServerResponse, clientAddress: string): Promise<void>
    {
        const A = AgentExchangeFront
        const budget = this.limit.HitAddress(clientAddress)
        if (!budget.Allowed)
        {
            req.resume()
            res.setHeader(A.RetryAfterHeader, String(budget.RetryAfterSeconds()))
            A.Refuse(res, AgentExchangeLink.StatusOf(AgentExchangeRefusal.Unavailable), AgentExchangeRefusal.Unavailable)
            return
        }
        if (req.method !== PlaneHttp.MethodPost)
        {
            req.resume()
            res.setHeader(A.AllowHeader, PlaneHttp.MethodPost)
            A.Refuse(res, A.StatusMethodNotAllowed, AgentExchangeRefusal.Malformed)
            return
        }
        const body = await A.ReadBody(req)
        if (body.Outcome === ExchangeBody.Dropped)
        {
            res.destroy()
            return
        }
        if (body.Outcome === ExchangeBody.TooLarge)
        {
            res.setHeader(A.ConnectionHeader, A.CloseValue)
            A.Refuse(res, AgentExchangeLink.StatusOf(AgentExchangeRefusal.TooLarge), AgentExchangeRefusal.TooLarge)
            return
        }
        let reply: InternalApiRelayReply
        try
        {
            reply = await this.admin.Relay(InternalApiRoutes.AgentExchange, body.Bytes, AgentExchangeLink.ContentType, A.MaxReplyBytes)
        }
        catch (error)
        {
            if (!(error instanceof InternalApiUnavailableError))
            {
                this.log(A.LogPrefix + ' ' + (error instanceof Error ? error.name : A.FallbackErrorName))
            }
            A.Refuse(res, AgentExchangeLink.StatusOf(AgentExchangeRefusal.Unavailable), AgentExchangeRefusal.Unavailable)
            return
        }
        // The console's guard refusing the link bearer is 401 with no refusal code of the exchange; a 401 naming one
        // (`not-verified`: the envelope did not verify) is the agent's answer and passes through.
        if (reply.Status === A.StatusUnauthorized && AgentExchangeLink.CodeOf(A.JsonOrNull(reply.Body)) === null)
        {
            this.log(A.LogPrefix + ' ' + A.LinkRefusedMessage)
            A.Refuse(res, AgentExchangeLink.StatusOf(AgentExchangeRefusal.Unavailable), AgentExchangeRefusal.Unavailable)
            return
        }
        const headers: Record<string, string> = { [A.CacheControlHeader]: A.NoStore }
        if (reply.ContentType !== null && reply.Body.length > 0)
        {
            headers[A.ContentTypeHeader] = reply.ContentType
        }
        res.writeHead(reply.Status, headers)
        res.end(reply.Body)
    }

    private static JsonOrNull(body: Buffer): unknown
    {
        try
        {
            return JSON.parse(body.toString(AgentExchangeFront.Utf8)) as unknown
        }
        catch
        {
            return null
        }
    }

    private static Refuse(res: ServerResponse, status: number, code: AgentExchangeRefusal): void
    {
        res.setHeader(AgentExchangeFront.CacheControlHeader, AgentExchangeFront.NoStore)
        PlaneHttp.WriteJson(res, status, AgentExchangeLink.RefusalBody(code))
    }

    /** The body under the 1 MiB limit: refused by its declared length unread, else while streaming. */
    private static ReadBody(req: IncomingMessage): Promise<ExchangeBodyRead>
    {
        const A = AgentExchangeFront
        const declared = Number(req.headers[A.ContentLengthHeader] ?? Number.NaN)
        if (Number.isFinite(declared) && declared > AgentExchangeLink.BodyLimit)
        {
            req.resume()
            return Promise.resolve(new ExchangeBodyRead(ExchangeBody.TooLarge, Buffer.alloc(0)))
        }
        return new Promise(resolve =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let settled = false
            const settle = (outcome: ExchangeBody): void =>
            {
                if (!settled)
                {
                    settled = true
                    resolve(new ExchangeBodyRead(outcome, outcome === ExchangeBody.Read ? Buffer.concat(chunks) : Buffer.alloc(0)))
                }
            }
            req.on(A.DataEvent, (chunk: Buffer) =>
            {
                size += chunk.length
                if (size > AgentExchangeLink.BodyLimit)
                {
                    chunks.length = 0
                    settle(ExchangeBody.TooLarge)
                    return
                }
                if (!settled)
                {
                    chunks.push(chunk)
                }
            })
            req.on(A.EndEvent, () => settle(ExchangeBody.Read))
            req.on(A.ErrorEvent, () => settle(ExchangeBody.Dropped))
            req.on(A.CloseEvent, () => settle(req.complete ? ExchangeBody.Read : ExchangeBody.Dropped))
        })
    }
}
