import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { AppHost, AppHostConfig, RouteTable } from '@pragmatic-tech-ai/pragmatic-app-host'
import { CentralLoginSubject, CustomerCallAuthenticator } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import type { ICentralLoginVerifier } from '@pragmatic-tech-ai/pragmatic-entitlements-contract'
import { CreateTenantRequest, CustomerApiClient, CustomerApiError, CustomerApiLink, CustomerApiRoutes, CustomerErrorCode, DomainVerification, DomainVerificationRequest, DomainVerificationState, EnrolmentStart, HiveHealth, HiveLevel, HiveView, LeaveHiveRequest, ListHivesRequest, ListTenantsRequest, NotEntitledReason, StartEnrolmentRequest, TenantView } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { ICustomerApiService } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import type { AgentChannelReply, IAgentChannelBackend, DiscoveryReply, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { CustomerApiConsoleClient } from '../customer-api-console-client.js'
import { CustomerApiFront } from '../customer-api-front.js'
import { CustomerApiRateLimit } from '../customer-api-rate-limit.js'
import { CustomerApiWire, CustomerApiWireCode } from '../customer-api-wire.js'
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

    it('the customer token header and its limit', () =>
    {
        assert.equal(CustomerApiWire.TokenHeader, CustomerCallAuthenticator.TokenHeader)
        assert.equal(CustomerApiWire.MaxTokenLength, CustomerCallAuthenticator.MaxTokenLength)
    })

    it('the refusals the edge writes itself are the contract\'s errors', () =>
    {
        const codes: ReadonlyArray<[CustomerApiWireCode, CustomerErrorCode]> = [
            [CustomerApiWireCode.NotSignedIn, CustomerErrorCode.NotSignedIn],
            [CustomerApiWireCode.Unavailable, CustomerErrorCode.Unavailable],
            [CustomerApiWireCode.InvalidRequest, CustomerErrorCode.InvalidRequest],
        ]
        for (const [edge, contract] of codes)
        {
            const error = new CustomerApiError(contract)
            const refusal = CustomerApiWire.Refusal(edge)
            assert.equal(refusal.Status, error.Status, edge)
            assert.deepEqual(refusal.Body, { ...error.Fields(), error: error.message }, edge)
        }
    })
})

class Subjects
{
    public static readonly Ann = CentralLoginSubject.Of('https://login.example.test/realms/central', 'ann', 'ann@acme.test')
}

class TokenVerifier implements ICentralLoginVerifier
{
    public async Verify(token: string): Promise<CentralLoginSubject | undefined>
    {
        return token === 'ann-token' ? Subjects.Ann : undefined
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

/** The contract's client → this edge → the contract's console routes on an AppHost. */
describe('customer API round trip through the edge', () =>
{
    const credential = CustomerApiLink.CredentialFromSecret(Buffer.alloc(32, 9))
    const service = new RecordingService()
    const routes = new RouteTable()
    new CustomerApiRoutes(service, new CustomerCallAuthenticator(credential, new TokenVerifier())).MountOn(routes)
    const admin = new AppHost(new AppHostConfig(), { Routes: routes })
    let edge: EdgeHost
    let client: CustomerApiClient

    before(async () =>
    {
        await admin.Listen(0, '127.0.0.1')
        const front = new CustomerApiFront(new CustomerApiConsoleClient('http://127.0.0.1:' + String(admin.Address().port), credential), new CustomerApiRateLimit())
        edge = new EdgeHost(new NoAgent(), new NoDiscovery(), false, front)
        await edge.Listen(0, '127.0.0.1')
        client = new CustomerApiClient('http://127.0.0.1:' + String(edge.Address().port))
    })

    after(async () =>
    {
        await edge.Close()
        await admin.Close()
    })

    it('every operation answers through the edge for a signed-in customer', async () =>
    {
        const created = await client.CreateTenant('ann-token', new CreateTenantRequest('acme', 'acme-prod', 'Acme'))
        assert.equal(created.TenantId, 'acme-prod')
        assert.equal((await client.ListTenants('ann-token', new ListTenantsRequest('acme'))).length, 1)
        assert.equal((await client.StartEnrolment('ann-token', new StartEnrolmentRequest('acme', 'acme-prod', HiveLevel.Hosted))).PlacementId, 'placement-1')
        assert.equal((await client.StartEnrolment('ann-token', new StartEnrolmentRequest('acme', 'acme-prod', HiveLevel.Standalone))).Level, HiveLevel.Standalone)
        assert.equal((await client.ListHives('ann-token', new ListHivesRequest('acme'))).length, 1)
        assert.equal((await client.StartDomainVerification('ann-token', new DomainVerificationRequest('acme', 'acme-prod', 'acme.test'))).State, DomainVerificationState.Pending)
        assert.equal((await client.CheckDomainVerification('ann-token', new DomainVerificationRequest('acme', 'acme-prod', 'acme.test'))).State, DomainVerificationState.Verified)
        assert.equal((await client.LeaveHive('ann-token', new LeaveHiveRequest('acme', 'hive-1'))).Health, HiveHealth.Gone)
        assert.ok(service.Callers.every(key => key === Subjects.Ann.Key))
    })

    it('a refusal keeps its code and reason end to end', async () =>
    {
        await assert.rejects(client.CreateTenant('ann-token', new CreateTenantRequest('acme', 'acme-two', 'Acme')), (err: unknown) =>
        {
            assert.ok(err instanceof CustomerApiError)
            assert.equal(err.CustomerCode, CustomerErrorCode.NotEntitled)
            assert.equal(err.Reason, NotEntitledReason.LimitReached)
            return true
        })
    })

    it('a token the console does not accept is not-signed-in; the edge never decides it', async () =>
    {
        await assert.rejects(client.ListTenants('someone-else', new ListTenantsRequest('acme')), (err: unknown) => err instanceof CustomerApiError && err.CustomerCode === CustomerErrorCode.NotSignedIn)
    })
})
