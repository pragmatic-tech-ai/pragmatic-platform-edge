import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-component'
import type { AgentChannelReply, AgentChannelRequest, IAgentChannelBackend, DiscoveryReply, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiConsoleClient, type CustomerApiReply } from '../customer-api-console-client.js'
import { CustomerApiFront, type ICustomerApiConsole } from '../customer-api-front.js'
import { CustomerApiRateLimit } from '../customer-api-rate-limit.js'
import { CustomerApiWire } from '../customer-api-wire.js'
import { EdgeHost, type EdgeHostOptions } from '../edge-host.js'

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

/** How the stand-in console answers. */
enum ConsoleMode
{
    Answer = 'answer',
    /** Status line and a byte every few milliseconds, never the end. */
    Drip = 'drip',
    /** Never answers. */
    Hang = 'hang',
}

/** A stand-in platform admin console: records every call and answers what the test sets. */
class FakeConsole
{
    public static readonly MaxHeaderBytes = 32 * 1024
    public readonly Seen: Seen[] = []
    public readonly Aborted: string[] = []
    public Status = 200
    public Body: unknown = { Tenants: [] }
    public Mode = ConsoleMode.Answer
    private server: Server | undefined
    private readonly timers = new Set<NodeJS.Timeout>()

    public async Start(): Promise<string>
    {
        // Above Node's 16 KiB header default, like the edge, so a 16 KiB bearer reaches this console too.
        const server = createServer({ maxHeaderSize: FakeConsole.MaxHeaderBytes }, (req, res) => this.Serve(req, res))
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        this.server = server
        return 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
    }

    public async Stop(): Promise<void>
    {
        for (const timer of this.timers)
        {
            clearInterval(timer)
        }
        const server = this.server
        this.server = undefined
        if (server !== undefined)
        {
            server.closeAllConnections()
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    private Serve(req: IncomingMessage, res: ServerResponse): void
    {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c as Buffer))
        req.on('end', () =>
        {
            this.Seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
            res.on('close', () =>
            {
                if (!res.writableFinished)
                {
                    this.Aborted.push(req.url ?? '')
                }
            })
            if (this.Mode === ConsoleMode.Hang)
            {
                return
            }
            res.writeHead(this.Status, { [FrontFixture.ContentType]: FrontFixture.Json })
            if (this.Mode === ConsoleMode.Drip)
            {
                const timer = setInterval(() => res.write(' '), 20)
                this.timers.add(timer)
                return
            }
            res.end(this.Body === undefined ? '' : JSON.stringify(this.Body))
        })
    }
}

/** A console that throws what the test hands it (the front's logging branch). */
class ThrowingConsole implements ICustomerApiConsole
{
    public constructor(private readonly error: Error)
    {
    }

    public async Post(): Promise<CustomerApiReply>
    {
        throw this.error
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

class FrontFixture
{
    public static readonly Credential = InternalApiCredential.FromSecret(Buffer.alloc(32, 7), CustomerApiWire.CredentialLabel)
    public static readonly Token = 'eyJhbGciOiJSUzI1NiJ9.customer-token-payload.signature'
    public static readonly BearerPrefix = 'Bearer '
    public static readonly Bearer = FrontFixture.BearerPrefix + FrontFixture.Token
    public static readonly Post = 'POST'
    public static readonly ContentType = 'content-type'
    public static readonly Json = 'application/json'
    public static readonly OtherToken = 'another-token'
    public static readonly Prefix = '/api/customer/v1/'
    public static readonly ListTenants = 'list-tenants'
    public static readonly ListTenantsPath = '/api/customer/v1/list-tenants'
    public static readonly Body = { ClientId: 'acme' }
    public static readonly Forwarded = 'x-forwarded-for'
    public static readonly Loopback = '127.0.0.1'
    public static readonly NotSignedIn = { error: 'Not signed in', code: 'not-signed-in' }
    public static readonly Unavailable = { error: 'The platform is unavailable', code: 'unavailable' }
    public static readonly RateLimited = { error: 'Too many requests', code: 'rate-limited' }

    public Host: EdgeHost | undefined
    public Admin: FakeConsole | undefined

    public async Start(options: { adminUrl?: string; limit?: CustomerApiRateLimit; trustedProxy?: boolean; timeoutMs?: number; bodyTimeoutMs?: number; admin?: ICustomerApiConsole; host?: EdgeHostOptions } = {}): Promise<FakeConsole>
    {
        const admin = new FakeConsole()
        this.Admin = admin
        const url = options.adminUrl ?? await admin.Start()
        const relay = options.admin ?? new CustomerApiConsoleClient(url, FrontFixture.Credential, options.timeoutMs)
        const front = new CustomerApiFront(relay, options.limit ?? new CustomerApiRateLimit(), { BodyTimeoutMs: options.bodyTimeoutMs })
        this.Host = new EdgeHost(new NoAgent(), new NoDiscovery(), options.trustedProxy ?? false, front, options.host)
        await this.Host.Listen(0, FrontFixture.Loopback)
        return admin
    }

    public async Stop(): Promise<void>
    {
        await this.Host?.Close()
        await this.Admin?.Stop()
        this.Host = undefined
        this.Admin = undefined
    }

    public Send(method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Reply>
    {
        const addr = (this.Host as EdgeHost).Address()
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers: { [FrontFixture.ContentType]: FrontFixture.Json, ...headers } }, res =>
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

    public Call(operation: string = FrontFixture.ListTenants, token: string | null = FrontFixture.Token, body: unknown = FrontFixture.Body, extra: Record<string, string> = {}): Promise<Reply>
    {
        const headers: Record<string, string> = { ...extra }
        if (token !== null)
        {
            headers.authorization = FrontFixture.BearerPrefix + token
        }
        return this.Send(FrontFixture.Post, FrontFixture.Prefix + operation, headers, JSON.stringify(body))
    }

    /** Writes raw bytes and resolves with what came back once the edge closed the connection (or `waitMs` passed). */
    public Raw(text: string, waitMs: number): Promise<{ text: string; closed: boolean }>
    {
        const addr = (this.Host as EdgeHost).Address()
        return new Promise(resolve =>
        {
            const socket = connect(addr.port, addr.address)
            let received = ''
            const timer = setTimeout(() =>
            {
                socket.destroy()
                resolve({ text: received, closed: false })
            }, waitMs)
            socket.on('data', c => { received += c.toString('utf8') })
            socket.on('error', () => undefined)
            socket.on('close', () =>
            {
                clearTimeout(timer)
                resolve({ text: received, closed: true })
            })
            socket.write(text)
        })
    }

    /** Sends a call and lets the caller go away once the console has it. */
    public async CallAndLeave(admin: FakeConsole): Promise<void>
    {
        const addr = (this.Host as EdgeHost).Address()
        const req = request({ host: addr.address, port: addr.port, method: FrontFixture.Post, path: FrontFixture.ListTenantsPath, headers: { [FrontFixture.ContentType]: FrontFixture.Json, authorization: FrontFixture.Bearer } })
        req.on('error', () => undefined)
        req.end(JSON.stringify(FrontFixture.Body))
        while (admin.Seen.length === 0)
        {
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        req.destroy()
    }

    public static async WaitFor(check: () => boolean, ms: number): Promise<boolean>
    {
        const until = Date.now() + ms
        while (Date.now() < until)
        {
            if (check())
            {
                return true
            }
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return check()
    }
}

describe('CustomerApiFront', () =>
{
    const fixture = new FrontFixture()

    afterEach(async () =>
    {
        await fixture.Stop()
    })

    it('relays a known operation verbatim and answers the admin\'s status and body, never cached', async () =>
    {
        const admin = await fixture.Start()
        admin.Status = 409
        admin.Body = { error: 'That tenant id is taken', code: 'tenant-taken' }
        const body = { ClientId: 'acme', TenantId: 'acme-prod', DisplayName: 'Acme' }
        const reply = await fixture.Call('create-tenant', FrontFixture.Token, body)
        assert.equal(reply.status, 409)
        assert.deepEqual(reply.body, { error: 'That tenant id is taken', code: 'tenant-taken' })
        assert.equal(reply.headers['cache-control'], 'no-store')
        assert.equal(admin.Seen.length, 1)
        const seen = admin.Seen[0]!
        assert.equal(seen.method, FrontFixture.Post)
        assert.equal(seen.path, '/internal/customer/v1/create-tenant')
        assert.equal(seen.headers.authorization, FrontFixture.Credential.AuthorizationValue())
        assert.equal(seen.headers['x-pragmatic-customer-token'], FrontFixture.Token)
        assert.equal(seen.headers.accept, FrontFixture.Json)
        assert.deepEqual(JSON.parse(seen.body), body)
    })

    it('an unknown operation under the prefix is 404 and never reaches the admin', async () =>
    {
        const admin = await fixture.Start()
        const paths = ['/api/customer/v1/delete-client', '/api/customer/v1/', '/api/customer/v1', '/api/customer/v1/list-tenants/x', '/api/customer/v1/list-tenants/',
            '/api/customer/v1/list-tenants?x=1', '/api/customer/v1/LIST-TENANTS', '/api/customer/v1/list%2Dtenants', '/api/customer/v1/%2E%2E/list-tenants',
            '//api/customer/v1/list-tenants', '/api/customer/v1%2Flist-tenants', '/api/customer/v1/list-tenants%2F', '/API/customer/v1/list-tenants', '/api/customer/v2/list-tenants', '/internal/customer/v1/list-tenants']
        for (const path of paths)
        {
            const reply = await fixture.Send(FrontFixture.Post, path, { authorization: FrontFixture.Bearer }, '{}')
            assert.equal(reply.status, 404, path)
        }
        assert.equal((await fixture.Send('GET', FrontFixture.ListTenantsPath, { authorization: FrontFixture.Bearer })).status, 404)
        assert.equal(admin.Seen.length, 0)
    })

    it('404s and 401s spend the client address\'s budget, counted before the bearer is looked at', async () =>
    {
        const clock = new ManualClock()
        const admin = await fixture.Start({ limit: new CustomerApiRateLimit({ PerAddressPerMinute: 3, Now: () => clock.Read() }) })
        assert.equal((await fixture.Call('nope')).status, 404)
        assert.equal((await fixture.Call(FrontFixture.ListTenants, null)).status, 401)
        assert.equal((await fixture.Call()).status, 200)
        const refused = await fixture.Call(FrontFixture.ListTenants, null)
        assert.equal(refused.status, 429)
        assert.deepEqual(refused.body, FrontFixture.RateLimited)
        assert.equal(admin.Seen.length, 1)
    })

    it('a body over 16 KiB is 413 with the connection closed, declared or counted, and never relayed', async () =>
    {
        const admin = await fixture.Start()
        const big = JSON.stringify({ ClientId: 'acme', Pad: 'x'.repeat(17 * 1024) })
        const declared = await fixture.Send(FrontFixture.Post, FrontFixture.ListTenantsPath, { authorization: FrontFixture.Bearer, 'content-length': String(Buffer.byteLength(big)) }, big)
        assert.equal(declared.status, 413)
        assert.deepEqual(declared.body, { error: 'The request is too large', code: 'too-large' })
        assert.equal(declared.headers.connection, 'close')
        const chunked = await fixture.Send(FrontFixture.Post, FrontFixture.ListTenantsPath, { authorization: FrontFixture.Bearer, 'transfer-encoding': 'chunked' }, big)
        assert.equal(chunked.status, 413)
        assert.equal(admin.Seen.length, 0)
    })

    it('a body of 1 MiB + 1 and a huge declared length are refused without being read, and never relayed', async () =>
    {
        const admin = await fixture.Start()
        const huge = Buffer.alloc(1048577, 0x20)
        const reply = await fixture.Send(FrontFixture.Post, FrontFixture.ListTenantsPath, { authorization: FrontFixture.Bearer, 'transfer-encoding': 'chunked' }, huge)
        assert.equal(reply.status, 413)
        const raw = await fixture.Raw('POST ' + FrontFixture.ListTenantsPath + ' HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: ' + FrontFixture.Bearer + '\r\nContent-Length: 2147483647\r\n\r\n{', 2000)
        assert.ok(raw.text.startsWith('HTTP/1.1 413'), raw.text)
        assert.equal(raw.closed, true)
        assert.equal(admin.Seen.length, 0)
    })

    it('a body that is not a JSON object is 400 invalid-request and never relayed', async () =>
    {
        const admin = await fixture.Start()
        for (const body of ['not json', '[1,2]', '"text"', 'null'])
        {
            const reply = await fixture.Send(FrontFixture.Post, FrontFixture.ListTenantsPath, { authorization: FrontFixture.Bearer }, body)
            assert.equal(reply.status, 400, body)
            assert.deepEqual(reply.body, { error: 'The request is not valid', code: 'invalid-request' })
        }
        assert.equal(admin.Seen.length, 0)
    })

    it('a body that does not arrive in time drops the connection, never relayed', async () =>
    {
        const admin = await fixture.Start({ bodyTimeoutMs: 200 })
        const raw = await fixture.Raw('POST ' + FrontFixture.ListTenantsPath + ' HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAuthorization: ' + FrontFixture.Bearer + '\r\nContent-Length: 20\r\n\r\n{"Cli', 3000)
        assert.equal(raw.closed, true)
        assert.equal(raw.text, '')
        assert.equal(admin.Seen.length, 0)
    })

    it('headers that do not arrive in time end the connection (the listener\'s own deadline)', async () =>
    {
        await fixture.Start({ host: { HeadersTimeoutMs: 300, RequestTimeoutMs: 600, CheckIntervalMs: 100 } })
        const raw = await fixture.Raw('POST ' + FrontFixture.ListTenantsPath + ' HTTP/1.1\r\nHost: x\r\n', 3000)
        assert.equal(raw.closed, true)
    })

    it('without a bearer, or with a malformed one, answers not-signed-in without relaying', async () =>
    {
        const admin = await fixture.Start()
        assert.deepEqual((await fixture.Call(FrontFixture.ListTenants, null)).body, FrontFixture.NotSignedIn)
        assert.equal((await fixture.Call(FrontFixture.ListTenants, null, {}, { authorization: 'Basic abc' })).status, 401)
        assert.equal((await fixture.Call(FrontFixture.ListTenants, null, {}, { authorization: FrontFixture.BearerPrefix })).status, 401)
        assert.equal(admin.Seen.length, 0)
    })

    it('a bearer of 16 KiB reaches the console; one byte more is not-signed-in (the listener takes the header)', async () =>
    {
        const admin = await fixture.Start()
        assert.equal((await fixture.Call(FrontFixture.ListTenants, 'x'.repeat(16384))).status, 200)
        assert.deepEqual((await fixture.Call(FrontFixture.ListTenants, 'x'.repeat(16385))).body, FrontFixture.NotSignedIn)
        assert.equal(admin.Seen.length, 1)
        assert.equal(admin.Seen[0]!.headers['x-pragmatic-customer-token'], 'x'.repeat(16384))
    })

    it('a bearer is taken up to 16 KiB and no longer', () =>
    {
        assert.equal(CustomerApiFront.TokenOf(FrontFixture.BearerPrefix + 'x'.repeat(16384)), 'x'.repeat(16384))
        assert.equal(CustomerApiFront.TokenOf(FrontFixture.BearerPrefix + 'x'.repeat(16385)), undefined)
        assert.equal(CustomerApiFront.TokenOf(['Bearer a', 'Bearer b']), undefined)
        assert.equal(CustomerApiFront.TokenOf('bearer abc'), undefined)
    })

    it('admin down → 503 unavailable', async () =>
    {
        const down = new FakeConsole()
        const url = await down.Start()
        await down.Stop()
        await fixture.Start({ adminUrl: url })
        const reply = await fixture.Call()
        assert.equal(reply.status, 503)
        assert.deepEqual(reply.body, FrontFixture.Unavailable)
    })

    it('an admin answer that is empty or not JSON is 503 unavailable, never the admin\'s text', async () =>
    {
        const admin = await fixture.Start()
        admin.Body = undefined
        assert.deepEqual((await fixture.Call()).body, FrontFixture.Unavailable)
    })

    it('an admin that drips its answer is cut off at the deadline', async () =>
    {
        const admin = await fixture.Start({ timeoutMs: 300 })
        admin.Mode = ConsoleMode.Drip
        const started = Date.now()
        const reply = await fixture.Call()
        assert.equal(reply.status, 503)
        assert.ok(Date.now() - started < 2000)
    })

    it('a customer who goes away ends the call to the admin', async () =>
    {
        const admin = await fixture.Start()
        admin.Mode = ConsoleMode.Hang
        const capture = new LogCapture()
        await capture.During(async () =>
        {
            await fixture.CallAndLeave(admin)
            assert.ok(await FrontFixture.WaitFor(() => admin.Aborted.length === 1, 2000))
            await new Promise(resolve => setTimeout(resolve, 50))
        })
        assert.deepEqual(capture.Lines, [], 'a caller leaving is not logged')
    })

    it('the admin refusing the link bearer is the platform\'s fault: 503, logged without secrets', async () =>
    {
        const capture = new LogCapture()
        const admin = await fixture.Start()
        admin.Status = 401
        admin.Body = { error: 'Unauthorized', code: 'unauthorized' }
        const reply = await capture.During(() => fixture.Call())
        assert.deepEqual(reply.body, FrontFixture.Unavailable)
        assert.equal(capture.Lines.length, 1)
        capture.AssertClean()
        admin.Body = FrontFixture.NotSignedIn
        assert.deepEqual((await fixture.Call()).body, FrontFixture.NotSignedIn)
    })

    it('no customer token or link bearer appears in the edge log, even when an error carries it', async () =>
    {
        const capture = new LogCapture()
        await fixture.Start({ admin: new ThrowingConsole(new TypeError('boom ' + FrontFixture.Token + ' ' + FrontFixture.Credential.Bearer())) })
        const reply = await capture.During(() => fixture.Call())
        assert.deepEqual(reply.body, FrontFixture.Unavailable)
        assert.equal(capture.Lines.length, 1)
        assert.ok(capture.Lines[0]!.includes('TypeError'))
        capture.AssertClean()
    })

    it('the 61st call in a minute with one bearer is 429, Retry-After counting down, while another bearer passes', async () =>
    {
        const clock = new ManualClock()
        const admin = await fixture.Start({ limit: new CustomerApiRateLimit({ Now: () => clock.Read() }) })
        for (let i = 0; i < 60; i++)
        {
            assert.equal((await fixture.Call()).status, 200, String(i))
        }
        const refused = await fixture.Call()
        assert.equal(refused.status, 429)
        assert.deepEqual(refused.body, FrontFixture.RateLimited)
        assert.equal(refused.headers['retry-after'], '60')
        clock.Now += 30_000
        assert.equal((await fixture.Call()).headers['retry-after'], '30')
        assert.equal((await fixture.Call(FrontFixture.ListTenants, FrontFixture.OtherToken)).status, 200)
        assert.equal(admin.Seen.length, 61)
        clock.Now += 30_000
        assert.equal((await fixture.Call()).status, 200)
    })

    it('the 601st call in a minute from one address is 429; an IPv6 /64 is one address', async () =>
    {
        const clock = new ManualClock()
        const admin = await fixture.Start({ limit: new CustomerApiRateLimit({ Now: () => clock.Read() }), trustedProxy: true })
        for (let i = 0; i < 600; i++)
        {
            const address = i % 2 === 0 ? '2001:db8:1:2::' + String(i % 9 + 1) : '2001:db8:1:2:ffff::1'
            assert.equal((await fixture.Call(FrontFixture.ListTenants, 'token-' + String(i % 20), FrontFixture.Body, { [FrontFixture.Forwarded]: address })).status, 200, String(i))
        }
        assert.equal((await fixture.Call(FrontFixture.ListTenants, 'fresh', FrontFixture.Body, { [FrontFixture.Forwarded]: '2001:db8:1:2:abcd::7' })).status, 429)
        assert.equal((await fixture.Call(FrontFixture.ListTenants, 'fresh', FrontFixture.Body, { [FrontFixture.Forwarded]: '2001:db8:1:3::1' })).status, 200)
        assert.equal(admin.Seen.length, 601)
    })

    it('without the customer-api setting the prefix is 404', async () =>
    {
        fixture.Host = new EdgeHost(new NoAgent(), new NoDiscovery(), false)
        await fixture.Host.Listen(0, FrontFixture.Loopback)
        assert.equal((await fixture.Call()).status, 404)
    })
})

/** Captures console output while a call runs, and checks it carries no secret. */
class LogCapture
{
    public readonly Lines: string[] = []

    public async During<T>(work: () => Promise<T>): Promise<T>
    {
        const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info }
        const capture = (...args: unknown[]): void =>
        {
            this.Lines.push(args.map(a => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '))
        }
        console.log = capture
        console.error = capture
        console.warn = capture
        console.info = capture
        try
        {
            return await work()
        }
        finally
        {
            Object.assign(console, originals)
        }
    }

    public AssertClean(): void
    {
        assert.ok(this.Lines.every(line => !line.includes(FrontFixture.Token) && !line.includes(FrontFixture.Credential.Bearer())), this.Lines.join('\n'))
    }
}

describe('CustomerApiRateLimit', () =>
{
    it('keys bearers by their SHA-256, never the token itself', () =>
    {
        assert.equal(CustomerApiRateLimit.TokenKey(FrontFixture.Token), createHash('sha256').update(FrontFixture.Token).digest('base64url'))
        assert.ok(!CustomerApiRateLimit.TokenKey(FrontFixture.Token).includes(FrontFixture.Token))
        const limit = new CustomerApiRateLimit({ PerTokenPerMinute: 1 })
        assert.equal(limit.HitToken(FrontFixture.Token).Allowed, true)
        assert.equal(limit.HitToken(FrontFixture.Token).Allowed, false)
        assert.equal(limit.HitToken(FrontFixture.OtherToken).Allowed, true)
    })

    it('keys IPv6 by its /64 and IPv4-mapped addresses by their IPv4 address', () =>
    {
        assert.equal(CustomerApiRateLimit.AddressKey('2001:DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('2001:db8:1:2::ff'), '2001:db8:1:2::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('::1'), '0:0:0:0::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('fe80::1%eth0'), 'fe80:0:0:0::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('::ffff:203.0.113.5'), '203.0.113.5')
        assert.equal(CustomerApiRateLimit.AddressKey('::3:4:5:6:1.2.3.4'), '0:0:3:4::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('2001:db8:1:2:3:4:1.2.3.4'), '2001:db8:1:2::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('64:ff9b::198.51.100.1'), '64:ff9b:0:0::/64')
        assert.equal(CustomerApiRateLimit.AddressKey('203.0.113.5'), '203.0.113.5')
    })

    it('holds at most MaxKeys keys: a new key evicts the oldest', () =>
    {
        const clock = new ManualClock()
        const limit = new CustomerApiRateLimit({ PerAddressPerMinute: 1, MaxKeys: 1, Now: () => clock.Read() })
        assert.equal(limit.HitAddress('198.51.100.1').Allowed, true)
        assert.equal(limit.HitAddress('198.51.100.1').Allowed, false)
        assert.equal(limit.HitAddress('198.51.100.2').Allowed, true)
        assert.equal(limit.HitAddress('198.51.100.1').Allowed, true, 'evicted, so counted afresh')
    })
})
