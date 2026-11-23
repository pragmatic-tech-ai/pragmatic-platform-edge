import type { IncomingMessage, ServerResponse } from 'node:http'
import { PlaneHttp } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiUnavailableError } from './customer-api-console-client.js'
import type { CustomerApiReply } from './customer-api-console-client.js'
import type { CustomerApiRateLimit, RateDecision } from './customer-api-rate-limit.js'
import { CustomerApiWire, CustomerApiWireCode } from './customer-api-wire.js'

/** What the front relays to: the platform admin console's internal customer API (CustomerApiConsoleClient). */
export interface ICustomerApiConsole
{
    Post(operation: string, customerToken: string, body: unknown, signal?: AbortSignal): Promise<CustomerApiReply>
}

export interface CustomerApiFrontOptions
{
    /** How long the whole request body may take to arrive (default 10 s); a slower one drops the connection. */
    BodyTimeoutMs?: number
}

/** What reading a request body found. */
enum BodyOutcome
{
    Read = 'read',
    TooLarge = 'too-large',
    /** The body did not arrive in time, or the caller went away: the connection is dropped. */
    Dropped = 'dropped',
}

class BodyRead
{
    public constructor(public readonly Outcome: BodyOutcome, public readonly Text: string)
    {
    }
}

/**
 * The edge's public face of the customer API (`/api/customer/v1/<operation>`, D2 §4). Every request under the prefix
 * spends the client address's budget first; then a `POST` naming one of the seven operations needs a bearer, spends
 * its budget, and has its body read under the 16 KiB limit and a deadline and checked to be a JSON object; it is relayed
 * to the platform admin console with the bearer moved to `x-pragmatic-customer-token`, and the console's answer comes
 * back verbatim (except a refusal of the link itself, which is the platform's fault: 503). Anything else under the
 * prefix is 404 and never reaches the console. Nothing is cached (`no-store`). The edge never verifies, logs or keeps
 * the customer's token: the console verifies it.
 */
export class CustomerApiFront
{
    public static readonly DefaultBodyTimeoutMs = 10_000
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly CacheControlHeader = 'Cache-Control'
    private static readonly NoStore = 'no-store'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly QuerySeparator = '?'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly AbortedEvent = 'aborted'
    private static readonly CloseEvent = 'close'
    private static readonly FinishEvent = 'finish'
    private static readonly StatusUnauthorized = 401
    private static readonly CodeField = 'code'
    private static readonly LinkUnauthorizedCode = 'unauthorized'
    private static readonly LogPrefix = '[customer-api]'
    private static readonly LinkRefusedMessage = 'the console refused the customer-API link bearer (secret files differ?)'
    private static readonly FallbackErrorName = 'Error'

    private readonly bodyTimeoutMs: number

    public constructor(private readonly admin: ICustomerApiConsole, private readonly limit: CustomerApiRateLimit, options: CustomerApiFrontOptions = {})
    {
        this.bodyTimeoutMs = options.BodyTimeoutMs ?? CustomerApiFront.DefaultBodyTimeoutMs
    }

    /** Whether the request is under the customer API's prefix (and so the front's to answer). */
    public static Owns(url: string): boolean
    {
        return CustomerApiWire.IsUnderPrefix(CustomerApiFront.PathOf(url))
    }

    /** The bearer of an `authorization` header, when it is one the console could take (at most 16 KiB). */
    public static TokenOf(authorization: string | string[] | undefined): string | undefined
    {
        const match = typeof authorization === 'string' ? CustomerApiFront.BearerPattern.exec(authorization) : null
        const token = match === null ? undefined : match[1] as string
        return token === undefined || token.length > CustomerApiWire.MaxTokenLength ? undefined : token
    }

    /** Answers a request under the prefix; `clientAddress` is the edge's (trusted-proxy aware) client address. */
    public async Handle(req: IncomingMessage, res: ServerResponse, clientAddress: string): Promise<void>
    {
        const F = CustomerApiFront
        res.setHeader(F.CacheControlHeader, F.NoStore)
        const gone = new AbortController()
        res.on(F.CloseEvent, () =>
        {
            if (!res.writableFinished)
            {
                gone.abort()
            }
        })
        try
        {
            if (!await this.Admitted(req, res, this.limit.HitAddress(clientAddress)))
            {
                return
            }
            const operation = F.OperationOf(req)
            if (operation === undefined)
            {
                await this.Refuse(req, res, CustomerApiWireCode.NotFound)
                return
            }
            const token = F.TokenOf(req.headers[F.AuthorizationHeader])
            if (token === undefined)
            {
                await this.Refuse(req, res, CustomerApiWireCode.NotSignedIn)
                return
            }
            if (!await this.Admitted(req, res, this.limit.HitToken(token)))
            {
                return
            }
            const read = await this.ReadBody(req)
            if (read.Outcome !== BodyOutcome.Read)
            {
                F.Close(req, res, read.Outcome)
                return
            }
            const body = F.ObjectOf(read.Text)
            if (body === undefined)
            {
                F.Write(res, CustomerApiWireCode.InvalidRequest)
                return
            }
            const reply = await this.admin.Post(operation, token, body, gone.signal)
            if (F.IsLinkRefusal(reply))
            {
                console.error(F.LogPrefix, F.LinkRefusedMessage)
                F.Write(res, CustomerApiWireCode.Unavailable)
                return
            }
            PlaneHttp.WriteJson(res, reply.Status, reply.Body)
        }
        catch (err)
        {
            if (gone.signal.aborted || res.destroyed)
            {
                // The customer went away: nothing to answer, nothing to log.
                return
            }
            if (!(err instanceof CustomerApiUnavailableError))
            {
                // The name only: an error's message or stack could carry request material.
                console.error(F.LogPrefix, err instanceof Error ? err.name : F.FallbackErrorName)
            }
            if (res.headersSent)
            {
                res.end()
                return
            }
            F.Write(res, CustomerApiWireCode.Unavailable)
        }
    }

    /** The operation a request names: a `POST` to exactly its public path, without a query (the API takes none). */
    private static OperationOf(req: IncomingMessage): string | undefined
    {
        const url = req.url ?? ''
        return req.method === PlaneHttp.MethodPost && !url.includes(CustomerApiFront.QuerySeparator) ? CustomerApiWire.OperationOfPath(url) : undefined
    }

    private static PathOf(url: string): string
    {
        return url.split(CustomerApiFront.QuerySeparator)[0] as string
    }

    /** A 401 `unauthorized` is the console refusing the edge's link bearer: a platform fault, never the customer's. */
    private static IsLinkRefusal(reply: CustomerApiReply): boolean
    {
        const body = reply.Body
        return reply.Status === CustomerApiFront.StatusUnauthorized && body !== null && typeof body === 'object'
            && (body as Record<string, unknown>)[CustomerApiFront.CodeField] === CustomerApiFront.LinkUnauthorizedCode
    }

    private async Admitted(req: IncomingMessage, res: ServerResponse, decision: RateDecision): Promise<boolean>
    {
        if (decision.Allowed)
        {
            return true
        }
        res.setHeader(CustomerApiFront.RetryAfterHeader, String(decision.RetryAfterSeconds()))
        await this.Refuse(req, res, CustomerApiWireCode.RateLimited)
        return false
    }

    /** Refuses before the body is used: a body within the limit is read first, so the answer reaches the caller on a
     *  connection it can keep; a bigger, slow or broken one gets the answer and the connection closed. */
    private async Refuse(req: IncomingMessage, res: ServerResponse, code: CustomerApiWireCode): Promise<void>
    {
        const read = await this.ReadBody(req)
        if (read.Outcome === BodyOutcome.Read)
        {
            CustomerApiFront.Write(res, code)
            return
        }
        CustomerApiFront.Close(req, res, read.Outcome, code)
    }

    /** Answers an over-limit body (or a refusal over one) and closes the connection once the answer is out; a dropped
     *  body gets no answer. */
    private static Close(req: IncomingMessage, res: ServerResponse, outcome: BodyOutcome, code: CustomerApiWireCode = CustomerApiWireCode.TooLarge): void
    {
        if (outcome === BodyOutcome.Dropped)
        {
            req.destroy()
            return
        }
        res.setHeader(CustomerApiFront.ConnectionHeader, CustomerApiFront.CloseValue)
        res.on(CustomerApiFront.FinishEvent, () => req.destroy())
        CustomerApiFront.Write(res, code)
    }

    private static ObjectOf(text: string): Record<string, unknown> | undefined
    {
        if (text.length === 0)
        {
            return {}
        }
        try
        {
            const value: unknown = JSON.parse(text)
            return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
        }
        catch
        {
            return undefined
        }
    }

    private static Write(res: ServerResponse, code: CustomerApiWireCode): void
    {
        const refusal = CustomerApiWire.Refusal(code)
        PlaneHttp.WriteJson(res, refusal.Status, refusal.Body)
    }

    /** Reads the body under the 16 KiB limit and the body deadline. A declared or counted length over the limit stops
     *  the read at once (TooLarge, nothing more is read); a body that is late or broken is Dropped. */
    private ReadBody(req: IncomingMessage): Promise<BodyRead>
    {
        const F = CustomerApiFront
        const declared = Number(req.headers[F.ContentLengthHeader])
        if (Number.isFinite(declared) && declared > CustomerApiWire.BodyLimit)
        {
            req.pause()
            return Promise.resolve(new BodyRead(BodyOutcome.TooLarge, ''))
        }
        if (req.readableEnded)
        {
            return Promise.resolve(new BodyRead(BodyOutcome.Read, ''))
        }
        return new Promise(resolve =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let done = false
            const finish = (read: BodyRead): void =>
            {
                if (done)
                {
                    return
                }
                done = true
                clearTimeout(deadline)
                req.off(F.DataEvent, onData)
                if (read.Outcome !== BodyOutcome.Read)
                {
                    req.pause()
                }
                resolve(read)
            }
            const onData = (c: Buffer): void =>
            {
                size += c.length
                if (size > CustomerApiWire.BodyLimit)
                {
                    finish(new BodyRead(BodyOutcome.TooLarge, ''))
                    return
                }
                chunks.push(c)
            }
            const deadline = setTimeout(() => finish(new BodyRead(BodyOutcome.Dropped, '')), this.bodyTimeoutMs)
            req.on(F.DataEvent, onData)
            req.on(F.EndEvent, () => finish(new BodyRead(BodyOutcome.Read, Buffer.concat(chunks).toString(F.Utf8))))
            req.on(F.ErrorEvent, () => finish(new BodyRead(BodyOutcome.Dropped, '')))
            req.on(F.AbortedEvent, () => finish(new BodyRead(BodyOutcome.Dropped, '')))
        })
    }
}
