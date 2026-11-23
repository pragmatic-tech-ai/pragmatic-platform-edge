import type { IncomingMessage, ServerResponse } from 'node:http'
import { PlaneHttp } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiUnavailableError } from './customer-api-console-client.js'
import type { CustomerApiConsoleClient } from './customer-api-console-client.js'
import type { CustomerApiRateLimit, RateDecision } from './customer-api-rate-limit.js'
import { CustomerApiWire, CustomerApiWireCode } from './customer-api-wire.js'

/** What reading a request body found. */
enum BodyOutcome
{
    Read = 'read',
    TooLarge = 'too-large',
    /** Far over the limit: the connection is dropped instead of drained. */
    Dropped = 'dropped',
}

class BodyRead
{
    public constructor(public readonly Outcome: BodyOutcome, public readonly Text: string)
    {
    }
}

/**
 * The edge's public face of the customer API (`/api/customer/v1/<operation>`, D2 §4): a `POST` naming one of the seven
 * operations is rate-limited (per client address, then per bearer), its body read under the 16 KiB limit and checked to
 * be a JSON object, and relayed to the platform admin console with the customer's bearer moved to
 * `x-pragmatic-customer-token`; the console's answer comes back verbatim. Anything else under the prefix is 404 and never
 * reaches the console. The edge never verifies, logs or keeps the customer's token: the console verifies it.
 */
export class CustomerApiFront
{
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly RetryAfterHeader = 'Retry-After'
    private static readonly ConnectionHeader = 'Connection'
    private static readonly CloseValue = 'close'
    private static readonly BearerPattern = /^Bearer (\S+)$/
    private static readonly QuerySeparator = '?'
    private static readonly Utf8 = 'utf8'
    /** An over-limit body up to this size is read and discarded so the 413 reaches the caller; a bigger one drops the
     *  connection. */
    private static readonly DrainLimit = 1048576
    private static readonly LogPrefix = '[customer-api]'
    private static readonly FallbackErrorName = 'Error'

    public constructor(private readonly client: CustomerApiConsoleClient, private readonly limit: CustomerApiRateLimit)
    {
    }

    /** Whether the request is under the customer API's prefix (and so the front's to answer). */
    public static Owns(url: string): boolean
    {
        return CustomerApiWire.IsUnderPrefix(CustomerApiFront.PathOf(url))
    }

    /** Answers a request under the prefix; `clientAddress` is the edge's (trusted-proxy aware) client address. */
    public async Handle(req: IncomingMessage, res: ServerResponse, clientAddress: string): Promise<void>
    {
        const F = CustomerApiFront
        try
        {
            const operation = req.method === PlaneHttp.MethodPost ? CustomerApiWire.OperationOfPath(F.PathOf(req.url ?? '')) : undefined
            if (operation === undefined)
            {
                await F.Refuse(req, res, CustomerApiWireCode.NotFound)
                return
            }
            if (!await F.Admitted(req, res, this.limit.HitAddress(clientAddress)))
            {
                return
            }
            const token = F.TokenOf(req)
            if (token === undefined)
            {
                await F.Refuse(req, res, CustomerApiWireCode.NotSignedIn)
                return
            }
            if (!await F.Admitted(req, res, this.limit.HitToken(token)))
            {
                return
            }
            const read = await F.ReadBody(req)
            if (read.Outcome === BodyOutcome.Dropped)
            {
                req.destroy()
                return
            }
            if (read.Outcome === BodyOutcome.TooLarge)
            {
                res.setHeader(F.ConnectionHeader, F.CloseValue)
                F.Write(res, CustomerApiWireCode.TooLarge)
                return
            }
            const body = F.ObjectOf(read.Text)
            if (body === undefined)
            {
                F.Write(res, CustomerApiWireCode.InvalidRequest)
                return
            }
            const reply = await this.client.Post(operation, token, body)
            PlaneHttp.WriteJson(res, reply.Status, reply.Body)
        }
        catch (err)
        {
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

    private static PathOf(url: string): string
    {
        return url.split(CustomerApiFront.QuerySeparator)[0] as string
    }

    /** The bearer of `authorization`, when it is one the console could take (at most 16 KiB). */
    private static TokenOf(req: IncomingMessage): string | undefined
    {
        const header = req.headers[CustomerApiFront.AuthorizationHeader]
        const match = typeof header === 'string' ? CustomerApiFront.BearerPattern.exec(header) : null
        const token = match === null ? undefined : match[1] as string
        return token === undefined || token.length > CustomerApiWire.MaxTokenLength ? undefined : token
    }

    private static async Admitted(req: IncomingMessage, res: ServerResponse, decision: RateDecision): Promise<boolean>
    {
        if (decision.Allowed)
        {
            return true
        }
        res.setHeader(CustomerApiFront.RetryAfterHeader, String(decision.RetryAfterSeconds()))
        await CustomerApiFront.Refuse(req, res, CustomerApiWireCode.RateLimited)
        return false
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

    /** Refuses before the body is used: it is drained (bounded) first, so the answer reaches the caller. */
    private static async Refuse(req: IncomingMessage, res: ServerResponse, code: CustomerApiWireCode): Promise<void>
    {
        const read = await CustomerApiFront.ReadBody(req)
        if (read.Outcome === BodyOutcome.Dropped)
        {
            req.destroy()
            return
        }
        CustomerApiFront.Write(res, code)
    }

    private static Write(res: ServerResponse, code: CustomerApiWireCode): void
    {
        const refusal = CustomerApiWire.Refusal(code)
        PlaneHttp.WriteJson(res, refusal.Status, refusal.Body)
    }

    /** Reads the body under the limit. A declared length over the drain limit drops at once; an over-limit body is
     *  counted (not kept) up to the drain limit, then dropped. */
    private static ReadBody(req: IncomingMessage): Promise<BodyRead>
    {
        const F = CustomerApiFront
        const declared = Number(req.headers[F.ContentLengthHeader])
        if (Number.isFinite(declared) && declared > F.DrainLimit)
        {
            return Promise.resolve(new BodyRead(BodyOutcome.Dropped, ''))
        }
        return new Promise((resolve, reject) =>
        {
            const chunks: Buffer[] = []
            let size = 0
            let done = false
            req.on('data', (c: Buffer) =>
            {
                if (done)
                {
                    return
                }
                size += c.length
                if (size > F.DrainLimit)
                {
                    done = true
                    chunks.length = 0
                    resolve(new BodyRead(BodyOutcome.Dropped, ''))
                    return
                }
                if (size <= CustomerApiWire.BodyLimit)
                {
                    chunks.push(c)
                }
            })
            req.on('end', () =>
            {
                if (done)
                {
                    return
                }
                done = true
                resolve(size > CustomerApiWire.BodyLimit ? new BodyRead(BodyOutcome.TooLarge, '') : new BodyRead(BodyOutcome.Read, Buffer.concat(chunks).toString(F.Utf8)))
            })
            req.on('error', err =>
            {
                if (!done)
                {
                    done = true
                    reject(err)
                }
            })
        })
    }
}
