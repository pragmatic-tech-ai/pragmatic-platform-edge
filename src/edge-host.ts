import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AgentChannelHost, type IAgentChannelBackend, type IDesktopDiscoveryBackend, DesktopDiscoveryEndpoint, PlaneHttp } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { AgentExchangeFront } from './agent-exchange-front.js'
import { CustomerApiFront } from './customer-api-front.js'
import { EdgeClientAddress } from './edge-client-address.js'

/** The listener's request deadlines (Node's own defaults let a slow client hold a connection for five minutes). */
export interface EdgeHostOptions
{
    /** The whole request (headers and body) must arrive within this (default 30 s: a hive uploads up to 1 MiB on the agent channel). */
    RequestTimeoutMs?: number
    /** The headers must arrive within this (default 10 s). */
    HeadersTimeoutMs?: number
    /** How often Node checks those deadlines (default 1 s). */
    CheckIntervalMs?: number
}

/**
 * The edge's one public listener (behind Caddy): the agent channel (the v1 token routes and the signed exchange's
 * verbatim relay, AgentExchangeFront), desktop discovery, a liveness probe and, when configured, the customer API's
 * relay (CustomerApiFront), nothing else. It holds no state of its own besides the
 * throttles; every answer comes from the backends or the platform admin console.
 */
export class EdgeHost
{
    public static readonly HealthzPath = '/healthz'
    private static readonly OkBody = { ok: true }
    private static readonly NotListeningMessage = 'EdgeHost is not listening'
    public static readonly DefaultRequestTimeoutMs = 30_000
    public static readonly DefaultHeadersTimeoutMs = 10_000
    public static readonly DefaultCheckIntervalMs = 1000
    /** Above Node's 16 KiB default, so a customer bearer of up to CustomerApiWire.MaxTokenLength (16 KiB) reaches the
     *  front's own length check instead of Node's 431. */
    public static readonly MaxHeaderBytes = 20 * 1024
    private static readonly ErrorEvent = 'error'

    private readonly channel: AgentChannelHost
    private readonly discovery: DesktopDiscoveryEndpoint
    private httpServer: HttpServer | undefined

    public constructor(agent: IAgentChannelBackend, discovery: IDesktopDiscoveryBackend, private readonly trustedProxy: boolean, private readonly customer?: CustomerApiFront, private readonly options: EdgeHostOptions = {}, private readonly exchange?: AgentExchangeFront)
    {
        this.channel = new AgentChannelHost(agent)
        this.discovery = new DesktopDiscoveryEndpoint(discovery, DesktopDiscoveryEndpoint.NewThrottle())
    }

    public Listen(port: number, bind: string): Promise<void>
    {
        const E = EdgeHost
        const server = createServer({
            requestTimeout: this.options.RequestTimeoutMs ?? E.DefaultRequestTimeoutMs,
            headersTimeout: this.options.HeadersTimeoutMs ?? E.DefaultHeadersTimeoutMs,
            connectionsCheckingInterval: this.options.CheckIntervalMs ?? E.DefaultCheckIntervalMs,
            maxHeaderSize: E.MaxHeaderBytes,
        }, (req, res) =>
        {
            void this.Serve(req, res)
        })
        return new Promise((resolve, reject) =>
        {
            server.once(EdgeHost.ErrorEvent, reject)
            server.listen(port, bind, () =>
            {
                server.off(EdgeHost.ErrorEvent, reject)
                this.httpServer = server
                resolve()
            })
        })
    }

    public async Close(): Promise<void>
    {
        const server = this.httpServer
        this.httpServer = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(res => server.close(() => res()))
        }
    }

    public Address(): { address: string; port: number }
    {
        const a = this.httpServer?.address() as AddressInfo | null | undefined
        if (a === null || a === undefined)
        {
            throw new Error(EdgeHost.NotListeningMessage)
        }
        return { address: a.address, port: a.port }
    }

    private async Serve(req: IncomingMessage, res: ServerResponse): Promise<void>
    {
        const url = req.url ?? ''
        if (url === EdgeHost.HealthzPath && req.method === PlaneHttp.MethodGet)
        {
            req.resume()
            PlaneHttp.WriteJson(res, PlaneHttp.StatusOk, EdgeHost.OkBody)
            return
        }
        if (url === DesktopDiscoveryEndpoint.Path && req.method === PlaneHttp.MethodPost)
        {
            await this.discovery.Handle(req, res, EdgeClientAddress.Of(req, this.trustedProxy))
            return
        }
        if (this.exchange !== undefined && AgentExchangeFront.Owns(url))
        {
            await this.exchange.Handle(req, res)
            return
        }
        if (AgentChannelHost.IsChannelPath(url))
        {
            await this.channel.Serve(req, res)
            return
        }
        if (this.customer !== undefined && CustomerApiFront.Owns(url))
        {
            await this.customer.Handle(req, res, EdgeClientAddress.Of(req, this.trustedProxy))
            return
        }
        req.resume()
        PlaneHttp.WriteNotFound(res)
    }
}
