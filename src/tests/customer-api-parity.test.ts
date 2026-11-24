import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { AppHost, AppHostConfig, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CentralLoginSubject, CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ICentralLoginVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, CustomerApiClient, CustomerApiError, CustomerApiLink, CustomerApiRoutes, CustomerErrorCode, CustomerErrorCodes, DomainVerification, DomainVerificationRequest, DomainVerificationState, EnrolmentStart, HiveHealth, HiveLevel, HiveView, LeaveHiveRequest, ListHivesRequest, EnvironmentRequest, RequestEnvironmentRequest, RequestedEnvironmentPurpose, ListTenantsRequest, NotEntitledReason, StartEnrolmentRequest, TenantView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { ICustomerApiService } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { AgentChannelReply, IAgentChannelBackend, DiscoveryReply, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiConsoleClient } from '../customer-api-console-client.js'
import { CustomerApiFront } from '../customer-api-front.js'
import { CustomerApiRateLimit } from '../customer-api-rate-limit.js'
import { CustomerApiWire } from '../customer-api-wire.js'
import { EdgeHost } from '../edge-host.js'

/** The edge's wire must stay the contract's (the edge cannot take the contract at runtime: its peers carry the engine). */
describe('customer API wire parity with pragmatic-customer-api-contract', () =>
{
    it('paths, operations, link label and body limit', () =>
    {
        assert.equal(CustomerApiWire.PublicBasePath, CustomerApiLink.PublicBasePath)
        assert.equal(CustomerApiWire.InternalBasePath, CustomerApiLink.InternalBasePath)
        assert.equal(CustomerApiWire.CredentialLabel, CustomerApiLink.CredentialLabel)
        assert.equal(CustomerApiWire.BodyLimit, CustomerApiLink.BodyLimit)
        assert.deepEqual([...CustomerApiWire.Operations], [...CustomerApiLink.Operations])
        for (const operation of CustomerApiLink.Operations)
        {
            assert.equal(CustomerApiWire.OperationOfPath(CustomerApiLink.PublicPathOf(operation)), operation)
            assert.equal(CustomerApiWire.InternalPathOf(operation), CustomerApiLink.InternalPathOf(operation))
        }
    })

    it('the console refusal of the link bearer is the contract unauthorized', () =>
    {
        assert.equal(CustomerApiWire.LinkRefusedCode, CustomerErrorCode.Unauthorized)
        assert.equal(CustomerApiWire.LinkRefusedStatus, CustomerErrorCodes.StatusOf(CustomerErrorCode.Unauthorized))
    })

    it('the customer token header and its limit', () =>
    {
        assert.equal(CustomerApiWire.TokenHeader, CustomerCallAuthenticator.TokenHeader)
        assert.equal(CustomerApiWire.MaxTokenLength, CustomerCallAuthenticator.MaxTokenLength)
    })

    it('every refusal the edge writes itself is a contract error: code, status and message', () =>
    {
        for (const code of CustomerApiWire.Codes)
        {
            const contract = CustomerErrorCodes.Parse(code)
            assert.ok(contract !== undefined, code + ' is a contract code')
            const error = new CustomerApiError(contract)
            const refusal = CustomerApiWire.Refusal(code)
            assert.equal(refusal.Status, CustomerErrorCodes.StatusOf(contract), code)
            assert.deepEqual(refusal.Body, { ...error.Fields(), error: CustomerErrorCodes.MessageOf(contract) }, code)
        }
    })
})

class Subjects
{
    public static readonly AnnToken = 'ann-token'
    public static readonly Loopback = 'http://127.0.0.1:'

    public static readonly Ann = CentralLoginSubject.Of('https://login.example.test/realms/central', 'ann', 'ann@acme.test')
}

class TokenVerifier implements ICentralLoginVerifier
{
    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        return token === Subjects.AnnToken ? Subjects.Ann : undefined
    }
}

/** The console's side of the contract, answering fixed values and remembering who called. */
class RecordingService implements ICustomerApiService
{
    public readonly Callers: string[] = []
    private static readonly Created = new Date('2026-11-23T10:00:00.000Z')

    public async CreateTenant(customer: CentralLoginSubject, request: CreateTenantRequest): Promise<TenantView>
    {
        this.Callers.push(customer.Key)
        if (request.TenantId === 'acme-two')
        {
            throw new CustomerApiError(CustomerErrorCode.NotEntitled, NotEntitledReason.LimitReached)
        }
        return new TenantView(request.TenantId, request.ClientId, request.DisplayName, RecordingService.Created)
    }

    public async ListTenants(customer: CentralLoginSubject, request: ListTenantsRequest): Promise<readonly TenantView[]>
    {
        this.Callers.push(customer.Key)
        return [new TenantView('acme-prod', request.ClientId, 'Acme', RecordingService.Created)]
    }

    public async StartEnrolment(_customer: CentralLoginSubject, request: StartEnrolmentRequest): Promise<EnrolmentStart>
    {
        return request.Level === HiveLevel.Hosted ? EnrolmentStart.Hosted('placement-1') : EnrolmentStart.Standalone('helm install pragmatic-engine')
    }

    public async ListHives(_customer: CentralLoginSubject, request: ListHivesRequest): Promise<readonly HiveView[]>
    {
        return [new HiveView('hive-1', request.TenantId ?? 'acme-prod', HiveLevel.Hosted, true, HiveHealth.Pending, null, [])]
    }

    public async StartDomainVerification(_customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return new DomainVerification(request.TenantId, request.Domain, DomainVerificationState.Pending, '_pragmatic-verification.' + request.Domain, 'pragmatic-domain-verification=t')
    }

    public async CheckDomainVerification(_customer: CentralLoginSubject, request: DomainVerificationRequest): Promise<DomainVerification>
    {
        return new DomainVerification(request.TenantId, request.Domain, DomainVerificationState.Verified, '_pragmatic-verification.' + request.Domain, 'pragmatic-domain-verification=t')
    }

    public async LeaveHive(_customer: CentralLoginSubject, request: LeaveHiveRequest): Promise<HiveView>
    {
        return new HiveView(request.HiveId, 'acme-prod', HiveLevel.Hosted, false, HiveHealth.Gone, null, [])
    }

    public async RequestEnvironment(_customer: CentralLoginSubject, request: RequestEnvironmentRequest): Promise<EnvironmentRequest>
    {
        return new EnvironmentRequest('inabcdefghijkl', request.HiveId, HiveLevel.Enrolled, new Date('2026-12-01T00:00:00.000Z'))
    }
}

class NoAgent implements IAgentChannelBackend
{
    public async Handle(): Promise<AgentChannelReply>
    {
        return { Status: 404, Body: {} }
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
        return { Status: 404, Body: {} }
    }
}

/** The contract's console routes on an AppHost, this edge in front of them, and the contract's client. */
class RoundTripFixture
{
    public static readonly Bind = '127.0.0.1'
    public readonly Credential = CustomerApiLink.CredentialFromSecret(Buffer.alloc(32, 9))
    public readonly Service = new RecordingService()
    private readonly admin: AppHost
    private readonly edges: EdgeHost[] = []

    public constructor()
    {
        const routes = new RouteTable()
        new CustomerApiRoutes(this.Service, new CustomerCallAuthenticator(this.Credential, new TokenVerifier())).MountOn(routes)
        this.admin = new AppHost(new AppHostConfig(), { Routes: routes })
    }

    public async Start(): Promise<void>
    {
        await this.admin.Listen(0, RoundTripFixture.Bind)
    }

    /** An edge in front of the console (with its own limit) and a client of it. */
    public async ClientThroughEdge(limit: CustomerApiRateLimit = new CustomerApiRateLimit()): Promise<CustomerApiClient>
    {
        const front = new CustomerApiFront(new CustomerApiConsoleClient(Subjects.Loopback + String(this.admin.Address().port), this.Credential), limit)
        const edge = new EdgeHost(new NoAgent(), new NoDiscovery(), false, front)
        await edge.Listen(0, RoundTripFixture.Bind)
        this.edges.push(edge)
        return new CustomerApiClient(Subjects.Loopback + String(edge.Address().port))
    }

    public async Stop(): Promise<void>
    {
        for (const edge of this.edges)
        {
            await edge.Close()
        }
        await this.admin.Close()
    }
}

describe('customer API round trip through the edge', () =>
{
    const fixture = new RoundTripFixture()

    before(async () =>
    {
        await fixture.Start()
    })

    after(async () =>
    {
        await fixture.Stop()
    })

    it('every operation answers through the edge for a signed-in customer', async () =>
    {
        const client = await fixture.ClientThroughEdge()
        const created = await client.CreateTenant(Subjects.AnnToken, new CreateTenantRequest('acme', 'acme-prod', 'Acme'))
        assert.equal(created.TenantId, 'acme-prod')
        assert.equal((await client.ListTenants(Subjects.AnnToken, new ListTenantsRequest('acme'))).length, 1)
        assert.equal((await client.StartEnrolment(Subjects.AnnToken, new StartEnrolmentRequest('acme', 'acme-prod', HiveLevel.Hosted))).PlacementId, 'placement-1')
        assert.equal((await client.StartEnrolment(Subjects.AnnToken, new StartEnrolmentRequest('acme', 'acme-prod', HiveLevel.Standalone))).Level, HiveLevel.Standalone)
        assert.equal((await client.ListHives(Subjects.AnnToken, new ListHivesRequest('acme'))).length, 1)
        assert.equal((await client.StartDomainVerification(Subjects.AnnToken, new DomainVerificationRequest('acme', 'acme-prod', 'acme.test'))).State, DomainVerificationState.Pending)
        assert.equal((await client.CheckDomainVerification(Subjects.AnnToken, new DomainVerificationRequest('acme', 'acme-prod', 'acme.test'))).State, DomainVerificationState.Verified)
        assert.equal((await client.LeaveHive(Subjects.AnnToken, new LeaveHiveRequest('acme', 'hive-1'))).Health, HiveHealth.Gone)
        assert.equal((await client.RequestEnvironment(Subjects.AnnToken, new RequestEnvironmentRequest('acme', 'hive-1', 'prod', RequestedEnvironmentPurpose.Runtime))).IntentId, 'inabcdefghijkl')
        assert.ok(fixture.Service.Callers.every(key => key === Subjects.Ann.Key))
    })

    it('a refusal keeps its code and reason end to end', async () =>
    {
        const client = await fixture.ClientThroughEdge()
        await assert.rejects(client.CreateTenant(Subjects.AnnToken, new CreateTenantRequest('acme', 'acme-two', 'Acme')), (err: unknown) =>
        {
            assert.ok(err instanceof CustomerApiError)
            assert.equal(err.CustomerCode, CustomerErrorCode.NotEntitled)
            assert.equal(err.Reason, NotEntitledReason.LimitReached)
            return true
        })
    })

    it('the rate limit of the edge reaches the client as rate-limited with its Retry-After', async () =>
    {
        const once = await fixture.ClientThroughEdge(new CustomerApiRateLimit({ PerTokenPerMinute: 1 }))
        await once.ListTenants(Subjects.AnnToken, new ListTenantsRequest('acme'))
        await assert.rejects(once.ListTenants(Subjects.AnnToken, new ListTenantsRequest('acme')), (err: unknown) =>
        {
            assert.ok(err instanceof CustomerApiError)
            assert.equal(err.CustomerCode, CustomerErrorCode.RateLimited)
            assert.equal(err.RetryAfterSeconds, 60)
            return true
        })
    })

    it('a token the console does not accept is not-signed-in; the edge never decides it', async () =>
    {
        const client = await fixture.ClientThroughEdge()
        await assert.rejects(client.ListTenants('someone-else', new ListTenantsRequest('acme')), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.NotSignedIn)
    })
})
