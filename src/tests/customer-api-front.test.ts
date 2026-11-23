import { strict as assert } from 'node:assert'
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-component'
import type { AgentChannelReply, AgentChannelRequest, IAgentChannelBackend, DiscoveryReply, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiConsoleClient } from '../customer-api-console-client.js'
import { CustomerApiFront } from '../customer-api-front.js'
import { CustomerApiRateLimit } from '../customer-api-rate-limit.js'
import { CustomerApiWire } from '../customer-api-wire.js'
import { EdgeHost } from '../edge-host.js'

type Reply = { status: number; body: unknown; headers: IncomingHttpHeaders }
type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string }

class NoAgent implements IAgentChannelBackend
{
    public async Handle(_request: AgentChannelRequest): Promise<AgentChannelReply>
    {
        return { Status: 404, Body: { error: 'unknown' } }
    }

    public ServesConsole(): boolean
    {
        return false
    }
}

class NoDiscovery implements IDesktopDiscoveryBackend
{
    public async Discover(): Promise<DiscoveryReply>
    {
        return { Status: 404, Body: { error: 'no-account' } }
    }
}

/** A stand-in platform admin console: records every call and answers what the test sets. */
class FakeConsole
{
    public readonly Seen: Seen[] = []
    public Status = 200
    public Body: unknown = { Tenants: [] }
    private server: Server | undefined

    public async Start(): Promise<string>
    {
        const server = createServer((req, res) =>
        {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c as Buffer))
            req.on('end', () =>
            {
                this.Seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
                res.writeHead(this.Status, { 'content-type': 'application/json' })
                res.end(JSON.stringify(this.Body))
            })
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        this.server = server
        return 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
    }

    public async Stop(): Promise<void>
    {
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }
}

class FrontFixture
{
    public static readonly Credential = InternalApiCredential.FromSecret(Buffer.alloc(32, 7), CustomerApiWire.CredentialLabel)
    public static readonly Token = 'eyJhbGciOiJSUzI1NiJ9.customer-token-payload.signature'

    public static Send(host: EdgeHost, method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply>
    {
        const addr = host.Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers: { 'content-type': 'application/json', ...headers } }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () =>
                {
                    const text = Buffer.concat(chunks).toString('utf8')
                    resolve({ status: res.statusCode ?? 0, body: text.length === 0 ? undefined : JSON.parse(text), headers: res.headers })
                })
            })
            req.on('error', reject)
            req.end(body)
        })
    }

    public static Call(host: EdgeHost, operation: string, token: string | null = FrontFixture.Token, body: unknown = { ClientId: 'acme' }, extra: Record<string, string> = {}): Promise<Reply>
    {
        const headers: Record<string, string> = { ...extra }
        if (token !== null)
        {
            headers.authorization = 'Bearer ' + token
        }
        return FrontFixture.Send(host, 'POST', '/api/customer/v1/' + operation, headers, JSON.stringify(body))
    }
}

/** A clock the rate-limit tests move by hand. */
class ManualClock
{
    public Now = 1_000_000

    public Read(): number
    {
        return this.Now
    }
}

describe('CustomerApiFront', () =>
{
    let host: EdgeHost | undefined
    let fake: FakeConsole | undefined

    afterEach(async () =>
    {
        await host?.Close()
        await fake?.Stop()
        host = undefined
        fake = undefined
    })

    async function Start(options: { adminUrl?: string; limit?: CustomerApiRateLimit; trustedProxy?: boolean; timeoutMs?: number } = {}): Promise<FakeConsole>
    {
        fake = new FakeConsole()
        const url = options.adminUrl ?? await fake.Start()
        const front = new CustomerApiFront(new CustomerApiConsoleClient(url, FrontFixture.Credential, options.timeoutMs), options.limit ?? new CustomerApiRateLimit())
        host = new EdgeHost(new NoAgent(), new NoDiscovery(), options.trustedProxy ?? false, front)
        await host.Listen(0, '127.0.0.1')
        return fake
    }

    it('relays a known operation verbatim and answers the admin\'s status and body', async () =>
    {
        const admin = await Start()
        admin.Status = 409
        admin.Body = { error: 'That tenant id is taken', code: 'tenant-taken' }
        const body = { ClientId: 'acme', TenantId: 'acme-prod', DisplayName: 'Acme' }
        const reply = await FrontFixture.Call(host!, 'create-tenant', FrontFixture.Token, body)
        assert.equal(reply.status, 409)
        assert.deepEqual(reply.body, { error: 'That tenant id is taken', code: 'tenant-taken' })
        assert.equal(admin.Seen.length, 1)
        const seen = admin.Seen[0]!
        assert.equal(seen.method, 'POST')
        assert.equal(seen.path, '/internal/customer/v1/create-tenant')
        assert.equal(seen.headers.authorization, FrontFixture.Credential.AuthorizationValue())
        assert.equal(seen.headers['x-pragmatic-customer-token'], FrontFixture.Token)
        assert.deepEqual(JSON.parse(seen.body), body)
    })

    it('an unknown operation under the prefix is 404 and never reaches the admin', async () =>
    {
        const admin = await Start()
        for (const path of ['/api/customer/v1/delete-client', '/api/customer/v1/', '/api/customer/v1', '/api/customer/v1/list-tenants/x', '/api/customer/v2/list-tenants', '/internal/customer/v1/list-tenants'])
        {
            const reply = await FrontFixture.Send(host!, 'POST', path, { authorization: 'Bearer ' + FrontFixture.Token }, '{}')
            assert.equal(reply.status, 404, path)
        }
        assert.equal((await FrontFixture.Send(host!, 'GET', '/api/customer/v1/list-tenants', { authorization: 'Bearer ' + FrontFixture.Token })).status, 404)
        assert.equal(admin.Seen.length, 0)
    })

    it('a body over 16 KiB is 413 before relaying, declared or counted', async () =>
    {
        const admin = await Start()
        const big = JSON.stringify({ ClientId: 'acme', Pad: 'x'.repeat(17 * 1024) })
        const declared = await FrontFixture.Send(host!, 'POST', '/api/customer/v1/list-tenants', { authorization: 'Bearer ' + FrontFixture.Token, 'content-length': String(Buffer.byteLength(big)) }, big)
        assert.equal(declared.status, 413)
        assert.equal((declared.body as { code: string }).code, 'too-large')
        const chunked = await FrontFixture.Send(host!, 'POST', '/api/customer/v1/list-tenants', { authorization: 'Bearer ' + FrontFixture.Token, 'transfer-encoding': 'chunked' }, big)
        assert.equal(chunked.status, 413)
        assert.equal(admin.Seen.length, 0)
    })

    it('a body that is not a JSON object is 400 invalid-request and never relayed', async () =>
    {
        const admin = await Start()
        for (const body of ['not json', '[1,2]', '"text"', 'null'])
        {
            const reply = await FrontFixture.Send(host!, 'POST', '/api/customer/v1/list-tenants', { authorization: 'Bearer ' + FrontFixture.Token }, body)
            assert.equal(reply.status, 400, body)
            assert.deepEqual(reply.body, { error: 'The request is not valid', code: 'invalid-request' })
        }
        assert.equal(admin.Seen.length, 0)
    })

    it('without a bearer, or with a malformed or oversized one, answers not-signed-in without relaying', async () =>
    {
        const admin = await Start()
        assert.deepEqual((await FrontFixture.Call(host!, 'list-tenants', null)).body, { error: 'Not signed in', code: 'not-signed-in' })
        assert.equal((await FrontFixture.Call(host!, 'list-tenants', null, {}, { authorization: 'Basic abc' })).status, 401)
        assert.equal((await FrontFixture.Call(host!, 'list-tenants', null, {}, { authorization: 'Bearer ' })).status, 401)
        // Node's own 16 KiB header limit answers 431 first; either way the call never reaches the console.
        assert.ok([401, 431].includes((await FrontFixture.Call(host!, 'list-tenants', 'x'.repeat(16385))).status))
        assert.equal(admin.Seen.length, 0)
    })

    it('admin down → 503 unavailable', async () =>
    {
        const down = new FakeConsole()
        const url = await down.Start()
        await down.Stop()
        await Start({ adminUrl: url })
        const reply = await FrontFixture.Call(host!, 'list-tenants')
        assert.equal(reply.status, 503)
        assert.deepEqual(reply.body, { error: 'The platform is unavailable', code: 'unavailable' })
    })

    it('an admin answer that is not JSON is 503 unavailable, never the admin\'s text', async () =>
    {
        const admin = await Start()
        admin.Body = undefined
        const reply = await FrontFixture.Call(host!, 'list-tenants')
        assert.equal(reply.status, 503)
        assert.equal((reply.body as { code: string }).code, 'unavailable')
    })

    it('no customer token appears in the edge log', async () =>
    {
        const lines: string[] = []
        const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info }
        const capture = (...args: unknown[]): void =>
        {
            lines.push(args.map(a => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '))
        }
        console.log = capture
        console.error = capture
        console.warn = capture
        console.info = capture
        try
        {
            const fakeConsole = await Start()
            await FrontFixture.Call(host!, 'list-tenants')
            fakeConsole.Body = undefined
            await FrontFixture.Call(host!, 'list-tenants')
            await fakeConsole.Stop()
            await FrontFixture.Call(host!, 'list-tenants')
            await FrontFixture.Call(host!, 'nope')
        }
        finally
        {
            Object.assign(console, originals)
        }
        assert.ok(lines.every(line => !line.includes(FrontFixture.Token) && !line.includes(FrontFixture.Credential.Bearer())), lines.join('\n'))
    })

    it('the 61st call in a minute with one bearer is 429 while another bearer from the same address passes', async () =>
    {
        const clock = new ManualClock()
        const admin = await Start({ limit: new CustomerApiRateLimit(60, 600, () => clock.Read()) })
        for (let i = 0; i < 60; i++)
        {
            assert.equal((await FrontFixture.Call(host!, 'list-tenants')).status, 200, String(i))
        }
        const refused = await FrontFixture.Call(host!, 'list-tenants')
        assert.equal(refused.status, 429)
        assert.deepEqual(refused.body, { error: 'Too many requests', code: 'rate-limited' })
        assert.ok(Number(refused.headers['retry-after']) >= 1)
        assert.equal((await FrontFixture.Call(host!, 'list-tenants', 'another-token')).status, 200)
        assert.equal(admin.Seen.length, 61)
        clock.Now += CustomerApiRateLimit.WindowMs
        assert.equal((await FrontFixture.Call(host!, 'list-tenants')).status, 200)
    })

    it('the 601st call in a minute from one address is 429', async () =>
    {
        const clock = new ManualClock()
        const admin = await Start({ limit: new CustomerApiRateLimit(60, 600, () => clock.Read()), trustedProxy: true })
        for (let i = 0; i < 600; i++)
        {
            assert.equal((await FrontFixture.Call(host!, 'list-tenants', 'token-' + String(i % 20), { ClientId: 'acme' }, { 'x-forwarded-for': '203.0.113.5' })).status, 200, String(i))
        }
        assert.equal((await FrontFixture.Call(host!, 'list-tenants', 'fresh', { ClientId: 'acme' }, { 'x-forwarded-for': '203.0.113.5' })).status, 429)
        assert.equal((await FrontFixture.Call(host!, 'list-tenants', 'fresh', { ClientId: 'acme' }, { 'x-forwarded-for': '203.0.113.6' })).status, 200)
        assert.equal(admin.Seen.length, 601)
    })

    it('without the customer-api setting the prefix is 404', async () =>
    {
        host = new EdgeHost(new NoAgent(), new NoDiscovery(), false)
        await host.Listen(0, '127.0.0.1')
        assert.equal((await FrontFixture.Call(host, 'list-tenants')).status, 404)
    })
})

describe('CustomerApiRateLimit', () =>
{
    it('forgets keys whose window has passed', () =>
    {
        const clock = new ManualClock()
        const limit = new CustomerApiRateLimit(1, 1, () => clock.Read())
        for (let i = 0; i < 100; i++)
        {
            assert.equal(limit.HitAddress('198.51.100.' + String(i)).Allowed, true)
            assert.equal(limit.HitToken('token-' + String(i)).Allowed, true)
        }
        assert.equal(limit.Size, 200)
        clock.Now += CustomerApiRateLimit.WindowMs
        assert.equal(limit.HitAddress('198.51.100.200').Allowed, true)
        assert.equal(limit.Size, 1)
    })

    it('keys bearers by their SHA-256, never the token itself', () =>
    {
        const limit = new CustomerApiRateLimit()
        limit.HitToken(FrontFixture.Token)
        assert.ok(limit.Keys().every(key => !key.includes(FrontFixture.Token)))
    })
})
