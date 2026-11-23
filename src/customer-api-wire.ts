import { InternalApiCredential, InternalApiSecretError } from '@pragmatic-tech-ai/pragmatic-component'

/** The codes of the refusals the edge writes itself (every other answer is the platform admin console's own); each is
 *  one of the contract's CustomerErrorCode values, with its status and message. */
export enum CustomerApiWireCode
{
    InvalidRequest = 'invalid-request',
    NotSignedIn = 'not-signed-in',
    NotFound = 'not-found',
    TooLarge = 'too-large',
    RateLimited = 'rate-limited',
    Unavailable = 'unavailable',
}

/** A refusal: its status and its `{ error, code }` body. */
export class CustomerApiRefusal
{
    public constructor(public readonly Status: number, public readonly Body: { error: string; code: CustomerApiWireCode })
    {
    }
}

/** The customer-API link's secret file is unusable: names the setting and the reason, never the bytes. */
export class CustomerApiLinkError extends Error
{
    private static readonly ErrorName = 'CustomerApiLinkError'
    private static readonly ReasonSeparator = ': '

    public constructor(setting: string, cause: InternalApiSecretError)
    {
        super(setting + CustomerApiLinkError.ReasonSeparator + cause.message, { cause })
        this.name = CustomerApiLinkError.ErrorName
    }
}

/**
 * The customer API's wire as pragmatic-customer-api-contract defines it (CustomerApiLink, CustomerCallAuthenticator,
 * CustomerApiError), held here because the edge cannot take the contract at runtime: its app-host peers bring the TODL
 * engine. `customer-api-parity.test.ts` pins every value to the contract's.
 */
export class CustomerApiWire
{
    public static readonly PublicBasePath = '/api/customer/v1/'
    public static readonly InternalBasePath = '/internal/customer/v1/'
    public static readonly CredentialLabel = 'pragmatic-customer-api/v1'
    public static readonly BodyLimit = 16384
    public static readonly TokenHeader = 'x-pragmatic-customer-token'
    public static readonly MaxTokenLength = 16384
    /** The console's refusal of the link bearer itself (a platform fault, never the customer's): status and code. */
    public static readonly LinkRefusedStatus = 401
    public static readonly LinkRefusedCode = 'unauthorized'
    public static readonly Codes: readonly CustomerApiWireCode[] = Object.values(CustomerApiWireCode)
    public static readonly Operations: readonly string[] = [
        'create-tenant',
        'list-tenants',
        'start-enrolment',
        'list-hives',
        'start-domain-verification',
        'check-domain-verification',
        'leave-hive',
    ]
    private static readonly PrefixRoot = '/api/customer/v1'
    private static readonly Table: ReadonlyMap<CustomerApiWireCode, readonly [number, string]> = new Map<CustomerApiWireCode, readonly [number, string]>([
        [CustomerApiWireCode.InvalidRequest, [400, 'The request is not valid']],
        [CustomerApiWireCode.NotSignedIn, [401, 'Not signed in']],
        [CustomerApiWireCode.NotFound, [404, 'No such operation']],
        [CustomerApiWireCode.TooLarge, [413, 'The request is too large']],
        [CustomerApiWireCode.RateLimited, [429, 'Too many requests']],
        [CustomerApiWireCode.Unavailable, [503, 'The platform is unavailable']],
    ])

    /** Whether a path lies under the public prefix (the front answers all of them, 404 for an unknown operation). */
    public static IsUnderPrefix(path: string): boolean
    {
        return path === CustomerApiWire.PrefixRoot || path.startsWith(CustomerApiWire.PublicBasePath)
    }

    /** The operation a public path names exactly, or undefined. */
    public static OperationOfPath(path: string): string | undefined
    {
        return CustomerApiWire.Operations.find(operation => CustomerApiWire.PublicBasePath + operation === path)
    }

    public static InternalPathOf(operation: string): string
    {
        return CustomerApiWire.InternalBasePath + operation
    }

    public static Refusal(code: CustomerApiWireCode): CustomerApiRefusal
    {
        const [status, message] = CustomerApiWire.Table.get(code) as readonly [number, string]
        return new CustomerApiRefusal(status, { error: message, code })
    }

    /** The link credential from the secret file the edge and the platform admin console share; `setting` names the
     *  variable in an error. */
    public static Credential(secretFile: string, setting: string): InternalApiCredential
    {
        try
        {
            return InternalApiCredential.FromFile(secretFile, CustomerApiWire.CredentialLabel)
        }
        catch (err)
        {
            if (err instanceof InternalApiSecretError)
            {
                throw new CustomerApiLinkError(setting, err)
            }
            throw err
        }
    }
}
