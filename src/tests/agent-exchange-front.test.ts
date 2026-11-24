import { strict as assert } from 'node:assert'
import { request } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { AgentExchangeLink, AgentExchangeRefusal } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { InternalApiRelayReply, InternalApiRoutes, InternalApiUnavailableError, type AgentChannelReply, type DiscoveryReply, type IAgentChannelBackend, type IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { AgentExchangeFront, AgentExchangeRateLimit, type IAgentExchangeRelay } from '../agent-exchange-front.js'
import { EdgeHost } from '../edge-host.js'

class ExchangeReply
{
    public constructor(public readonly Status: number, public readonly Text: string, public readonly ContentType: string | undefined)
    {
    }
}

/** The console's internal listener, standing in: records what was relayed, answers what the test sets. */
class FakeConsole implements IAgentExchangeRelay
{
    public readonly Relayed: { Path: string, Body: Buffer, ContentType: string }[] = []
    public Answer: () => Promise<InternalApiRelayReply> = () => Promise.resolve(new InternalApiRelayReply(204, Buffer.alloc(0), null))

    public Relay(path: string, body: Buffer, contentType: string): Promise<InternalApiRelayReply>
    {
        this.Relayed.push({ Path: path, Body: body, ContentType: contentType })
        return this.Answer()
    }
}

class UnusedBackends implements IAgentChannelBackend, IDesktopDiscoveryBackend
{
    public Handle(): Promise<AgentChannelReply>
    {
        return Promise.reject(new Error('unused'))
    }

    public ServesConsole(): boolean
    {
        return false
    }

    public Discover(): Promise<DiscoveryReply>
    {
        return Promise.reject(new Error('unused'))
    }
}

class ExchangeFixture
{
    public static readonly Envelope = '{"Protocol":1,"Kind":"hive.report","odd":"\\u00e9 \\u2028 bytes"}'
    public static readonly Answer = '{"Protocol":1,"Kind":"platform.hive-enrolment-response"}'

    public static async Start(console: FakeConsole, logs: string[] = [], limit: AgentExchangeRateLimit = new AgentExchangeRateLimit()): Promise<EdgeHost>
    {
        const backends = new UnusedBackends()
        const host = new EdgeHost(backends, backends, false, undefined, {}, new AgentExchangeFront(console, limit, line => logs.push(line)))
        await host.Listen(0, '127.0.0.1')
        return host
    }

    public static Send(host: EdgeHost, method: string, body?: string, path: string = AgentExchangeLink.PublicPath): Promise<ExchangeReply>
    {
        const address = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: address.address, port: address.port, method, path, headers: { 'content-type': 'application/json' } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk as Buffer))
                res.on('end', () => resolve(new ExchangeReply(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'), res.headers['content-type'])))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('AgentExchangeFront', () =>
{
    const F = ExchangeFixture
    let host: EdgeHost | undefined

    afterEach(async () =>
    {
        await host?.Close()
        host = undefined
    })

    it('relays a body verbatim and answers 200 with the admin\'s envelope', async () =>
    {
        const admin = new FakeConsole()
        admin.Answer = () => Promise.resolve(new InternalApiRelayReply(200, Buffer.from(F.Answer), 'application/json'))
        host = await F.Start(admin)
        const reply = await F.Send(host, 'POST', F.Envelope)
        assert.equal(reply.Status, 200)
        assert.equal(reply.Text, F.Answer)
        assert.match(reply.ContentType ?? '', /application\/json/)
        assert.equal(admin.Relayed.length, 1)
        assert.equal(admin.Relayed[0]?.Path, InternalApiRoutes.AgentExchange)
        assert.ok(admin.Relayed[0]?.Body.equals(Buffer.from(F.Envelope, 'utf8')))
    })

    it('204 passes through, and a refusal with its status and code', async () =>
    {
        const admin = new FakeConsole()
        host = await F.Start(admin)
        assert.equal((await F.Send(host, 'POST', F.Envelope)).Status, 204)
        const refusal = JSON.stringify(AgentExchangeLink.RefusalBody(AgentExchangeRefusal.Mismatch))
        admin.Answer = () => Promise.resolve(new InternalApiRelayReply(403, Buffer.from(refusal), 'application/json'))
        const refused = await F.Send(host, 'POST', F.Envelope)
        assert.equal(refused.Status, 403)
        assert.equal(refused.Text, refusal)
    })

    it('over 1 MiB is 413 before relaying', async () =>
    {
        const admin = new FakeConsole()
        host = await F.Start(admin)
        const reply = await F.Send(host, 'POST', 'x'.repeat(AgentExchangeLink.BodyLimit + 1))
        assert.equal(reply.Status, 413)
        assert.equal(AgentExchangeLink.CodeOf(JSON.parse(reply.Text)), AgentExchangeRefusal.TooLarge)
        assert.equal(admin.Relayed.length, 0)
    })

    it('GET is 405', async () =>
    {
        const admin = new FakeConsole()
        host = await F.Start(admin)
        assert.equal((await F.Send(host, 'GET')).Status, 405)
        assert.equal(admin.Relayed.length, 0)
    })

    it('admin down → 503, and admin refusing the link bearer → 503', async () =>
    {
        const admin = new FakeConsole()
        const logs: string[] = []
        host = await F.Start(admin, logs)
        admin.Answer = () => Promise.reject(new InternalApiUnavailableError())
        const down = await F.Send(host, 'POST', F.Envelope)
        assert.equal(down.Status, 503)
        assert.equal(AgentExchangeLink.CodeOf(JSON.parse(down.Text)), AgentExchangeRefusal.Unavailable)
        admin.Answer = () => Promise.resolve(new InternalApiRelayReply(401, Buffer.from('{"code":"unauthorized"}'), 'application/json'))
        assert.equal((await F.Send(host, 'POST', F.Envelope)).Status, 503)
        assert.ok(logs.every(line => !line.includes('hive.report')), 'the envelope is never logged')
    })

    it('a 401 naming not-verified is the platform refusal and passes through, never logged as the link', async () =>
    {
        const admin = new FakeConsole()
        const logs: string[] = []
        host = await F.Start(admin, logs)
        const refusal = JSON.stringify(AgentExchangeLink.RefusalBody(AgentExchangeRefusal.NotVerified))
        admin.Answer = () => Promise.resolve(new InternalApiRelayReply(401, Buffer.from(refusal), 'application/json'))
        const reply = await F.Send(host, 'POST', F.Envelope)
        assert.equal(reply.Status, 401)
        assert.equal(AgentExchangeLink.CodeOf(JSON.parse(reply.Text)), AgentExchangeRefusal.NotVerified)
        assert.deepEqual(logs, [])
    })

    it('each client address has a budget: past it, 503 with Retry-After and nothing relayed', async () =>
    {
        const admin = new FakeConsole()
        host = await F.Start(admin, [], new AgentExchangeRateLimit({ PerAddressPerMinute: 2 }))
        assert.equal((await F.Send(host, 'POST', F.Envelope)).Status, 204)
        assert.equal((await F.Send(host, 'POST', F.Envelope)).Status, 204)
        const limited = await F.Send(host, 'POST', F.Envelope)
        assert.equal(limited.Status, 503)
        assert.equal(AgentExchangeLink.CodeOf(JSON.parse(limited.Text)), AgentExchangeRefusal.Unavailable)
        assert.equal(admin.Relayed.length, 2)
    })

    it('a thrown non-Error is logged by a fixed name only', async () =>
    {
        const admin = new FakeConsole()
        const logs: string[] = []
        host = await F.Start(admin, logs)
        admin.Answer = () => Promise.reject('SECRET-TEXT from somewhere')
        assert.equal((await F.Send(host, 'POST', F.Envelope)).Status, 503)
        assert.equal(logs.length, 1)
        assert.ok(!logs[0]!.includes('SECRET'))
    })

    it('owns only the exchange path', () =>
    {
        assert.equal(AgentExchangeFront.Owns('/agent/v2/exchange'), true)
        assert.equal(AgentExchangeFront.Owns('/agent/v2/exchange?x=1'), true)
        assert.equal(AgentExchangeFront.Owns('/agent/v2/exchange/more'), false)
        assert.equal(AgentExchangeFront.Owns('/agent/hives/h1/target'), false)
    })
})
