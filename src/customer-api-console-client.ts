import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-component'
import { CustomerApiWire } from './customer-api-wire.js'

/** The console's answer: its status and its JSON body, handed back to the caller unchanged. */
export class CustomerApiReply
{
    public constructor(public readonly Status: number, public readonly Body: unknown)
    {
    }
}

/** The console did not answer in time, or not with JSON. Carries no response text. */
export class CustomerApiUnavailableError extends Error
{
    private static readonly ErrorName = 'CustomerApiUnavailableError'
    private static readonly MessageText = 'platform admin console customer API unavailable'

    public constructor()
    {
        super(CustomerApiUnavailableError.MessageText)
        this.name = CustomerApiUnavailableError.ErrorName
    }
}

/**
 * The edge's client for the platform admin console's internal customer API: a JSON POST to
 * `/internal/customer/v1/<operation>` with the link bearer in `authorization` and the customer's own token in
 * `x-pragmatic-customer-token` (moved, never verified or kept), under a hard deadline for the whole exchange (a console
 * that drips its answer is cut off too). Any status the console answers comes back as it is; no answer, an empty one or
 * one that is not JSON is CustomerApiUnavailableError. `signal` aborts the call (the customer went away).
 */
export class CustomerApiConsoleClient
{
    public static readonly DefaultTimeoutMs = 5000
    private static readonly MaxReplyBytes = 4 * 1048576
    private static readonly HttpsScheme = 'https:'
    private static readonly MethodPost = 'POST'
    private static readonly ContentTypeHeader = 'content-type'
    private static readonly AcceptHeader = 'accept'
    private static readonly ContentLengthHeader = 'content-length'
    private static readonly AuthorizationHeader = 'authorization'
    private static readonly JsonType = 'application/json'
    private static readonly Utf8 = 'utf8'
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly TimeoutEvent = 'timeout'

    private readonly base: URL

    public constructor(adminBaseUrl: string, private readonly credential: InternalApiCredential, private readonly timeoutMs: number = CustomerApiConsoleClient.DefaultTimeoutMs)
    {
        this.base = new URL(adminBaseUrl)
    }

    public Post(operation: string, customerToken: string, body: unknown, signal?: AbortSignal): Promise<CustomerApiReply>
    {
        const C = CustomerApiConsoleClient
        const url = new URL(CustomerApiWire.InternalPathOf(operation), this.base)
        const payload = Buffer.from(JSON.stringify(body), C.Utf8)
        const send = url.protocol === C.HttpsScheme ? httpsRequest : httpRequest
        return new Promise<CustomerApiReply>((resolve, reject) =>
        {
            let settled = false
            const fail = (): void =>
            {
                if (!settled)
                {
                    settled = true
                    reject(new CustomerApiUnavailableError())
                }
            }
            const req = send(url, {
                method: C.MethodPost,
                timeout: this.timeoutMs,
                signal,
                headers: {
                    [C.ContentTypeHeader]: C.JsonType,
                    [C.AcceptHeader]: C.JsonType,
                    [C.ContentLengthHeader]: String(payload.length),
                    [C.AuthorizationHeader]: this.credential.AuthorizationValue(),
                    [CustomerApiWire.TokenHeader]: customerToken,
                },
            }, res =>
            {
                const chunks: Buffer[] = []
                let size = 0
                res.on(C.DataEvent, (c: Buffer) =>
                {
                    size += c.length
                    if (size > C.MaxReplyBytes)
                    {
                        fail()
                        req.destroy()
                        return
                    }
                    chunks.push(c)
                })
                res.on(C.ErrorEvent, fail)
                res.on(C.EndEvent, () =>
                {
                    if (settled)
                    {
                        return
                    }
                    try
                    {
                        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString(C.Utf8))
                        settled = true
                        resolve(new CustomerApiReply(res.statusCode ?? 0, parsed))
                    }
                    catch
                    {
                        fail()
                    }
                })
            })
            const deadline = setTimeout(() =>
            {
                fail()
                req.destroy()
            }, this.timeoutMs)
            req.on(C.CloseEvent, () =>
            {
                clearTimeout(deadline)
                fail()
            })
            req.on(C.TimeoutEvent, () =>
            {
                fail()
                req.destroy()
            })
            req.on(C.ErrorEvent, fail)
            req.end(payload)
        })
    }
}
