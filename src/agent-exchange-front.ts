import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgentExchangeLink, AgentExchangeRefusal } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { InternalApiRoutes, InternalApiUnavailableError, PlaneHttp, type InternalApiRelayReply } from '@pragmatic-tech-ai/pragmatic-platform-link'

/** What the front relays to: the platform admin console's internal listener (InternalApiClient). */
export interface IAgentExchangeRelay
{
    Relay(path: string, body: Buffer, contentType: string, maxReplyBytes: number): Promise<InternalApiRelayReply>
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
 * relayed; the console unreachable, or refusing the link itself, is 503 `unavailable` (the platform's fault).
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
    /** The console's answer is an envelope (at most 1 MiB) or a short refusal. */
    private static readonly MaxReplyBytes = AgentExchangeLink.BodyLimit + 65536
    private static readonly DataEvent = 'data'
    private static readonly EndEvent = 'end'
    private static readonly ErrorEvent = 'error'
    private static readonly CloseEvent = 'close'
    private static readonly LogPrefix = '[agent-exchange]'
    private static readonly LinkRefusedMessage = 'the console refused the internal-API link bearer (secret files differ?)'

    public constructor(private readonly admin: IAgentExchangeRelay, private readonly log: (line: string) => void = line => console.error(line))
    {
    }

    /** Whether the request is the exchange's (and so the front's to answer). */
    public static Owns(url: string): boolean
    {
        return url.split(AgentExchangeFront.QuerySeparator)[0] === AgentExchangeLink.PublicPath
    }

    /** Answers the exchange; never throws. */
    public async Handle(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const A = AgentExchangeFront
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
                this.log(A.LogPrefix + ' ' + (error instanceof Error ? error.name : String(error)))
            }
            A.Refuse(res, AgentExchangeLink.StatusOf(AgentExchangeRefusal.Unavailable), AgentExchangeRefusal.Unavailable)
            return
        }
        if (reply.Status === A.StatusUnauthorized)
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
