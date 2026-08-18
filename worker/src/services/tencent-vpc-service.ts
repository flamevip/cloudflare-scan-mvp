import type { Env } from '../env';
import { ProviderLaunchError, classifyProviderHttpError, classifyTencentProviderCode, providerConfigMissing } from './provider-errors';
import { normalizePublicIpv4 } from './provider-egress-service';
import { buildTencentTc3ServiceRequest } from './tencent-tc3-service';

const TENCENT_VPC_ENDPOINT = 'https://vpc.tencentcloudapi.com/';
const TENCENT_VPC_HOST = 'vpc.tencentcloudapi.com';
const TENCENT_VPC_SERVICE = 'vpc';
const TENCENT_VPC_VERSION = '2017-03-12';
const DEFAULT_API_TIMEOUT_MS = 10_000;
const MAX_API_TIMEOUT_MS = 30_000;
const RELEASE_CONFIRM_ATTEMPTS = 5;
const RELEASE_CONFIRM_DELAY_MS = 1_000;

export interface TencentVpcAddress {
  AddressId?: string;
  AddressIp?: string;
  AddressStatus?: string;
  AddressType?: string;
  InstanceId?: string;
  InstanceType?: string;
  NetworkInterfaceId?: string;
}

interface TencentVpcResponseBody {
  Response?: {
    Error?: { Code?: string; Message?: string };
    RequestId?: string;
    TaskId?: string;
    TotalCount?: number;
    AddressSet?: TencentVpcAddress[];
  };
}

export interface TencentEksEipCleanupHint {
  provider_job_id: string;
  provider_eip_id?: string | null;
  provider_egress_ip?: string | null;
}

export interface TencentEksEipCleanupResult {
  attempted: boolean;
  released: boolean;
  already_absent: boolean;
  address_id: string | null;
  request_id: string | null;
}

export interface TencentEksEipIdentity {
  provider_eip_id: string | null;
  provider_egress_ip: string | null;
}

/**
 * Resolve an auto-created EIP while it is still associated with the EKS CI
 * instance.  A task can be cancelled before the agent has sent a heartbeat,
 * which means the TKE Describe response has not populated AutoCreatedEipId or
 * EipAddress yet.  VPC DescribeAddresses still exposes the exact association
 * and gives cleanup a safe identity to use.
 */
export async function discoverTencentEksAutoCreatedEip(env: Env, providerJobId: string): Promise<TencentEksEipIdentity> {
  if (!/^eksci-[A-Za-z0-9-]+$/.test(providerJobId)) throw cleanupError('Tencent EKS CI provider job ID is invalid');
  const result = await describeTencentAddresses(env, { instance_id: providerJobId });
  if (!result.address) return { provider_eip_id: null, provider_egress_ip: null };
  if (result.address.InstanceId && result.address.InstanceId !== providerJobId) {
    throw cleanupError(`Tencent EIP is associated with another resource ${result.address.InstanceId}`);
  }
  if (result.address.AddressType && result.address.AddressType !== 'EIP') {
    throw cleanupError(`refusing to use non-EIP Tencent address type=${result.address.AddressType}`);
  }
  return {
    provider_eip_id: normalizeEipId(result.address.AddressId),
    provider_egress_ip: result.address.AddressIp ? normalizePublicIpv4(result.address.AddressIp) : null,
  };
}

export async function cleanupTencentEksAutoCreatedEip(env: Env, hint: TencentEksEipCleanupHint): Promise<TencentEksEipCleanupResult> {
  const addressId = normalizeEipId(hint.provider_eip_id);
  const addressIp = hint.provider_egress_ip ? normalizePublicIpv4(hint.provider_egress_ip) : null;
  if (!addressId && !addressIp) {
    throw cleanupError('Tencent auto-created EIP identity is unavailable; refusing to mark provider cleanup complete');
  }

  const before = await describeTencentAddresses(env, { address_id: addressId, address_ip: addressIp });
  if (!before.address) {
    return { attempted: true, released: false, already_absent: true, address_id: addressId, request_id: before.request_id };
  }
  assertExactCleanupTarget(before.address, hint.provider_job_id, addressId, addressIp);

  let releaseRequestId: string | null = null;
  const status = String(before.address.AddressStatus ?? '').toUpperCase();
  if (status !== 'OFFLINING') {
    if (status !== 'UNBIND' || before.address.InstanceId || before.address.NetworkInterfaceId) {
      throw cleanupError(`Tencent EIP ${before.address.AddressId ?? addressIp} is not safely releasable status=${status || 'unknown'}`);
    }
    const released = await releaseTencentAddresses(env, [requiredEipId(before.address.AddressId)]);
    releaseRequestId = released.request_id;
  }

  for (let attempt = 0; attempt < RELEASE_CONFIRM_ATTEMPTS; attempt++) {
    const confirmation = await describeTencentAddresses(env, {
      address_id: requiredEipId(before.address.AddressId),
      address_ip: addressIp,
    });
    if (!confirmation.address) {
      return {
        attempted: true,
        released: status !== 'OFFLINING',
        already_absent: false,
        address_id: requiredEipId(before.address.AddressId),
        request_id: releaseRequestId,
      };
    }
    if (attempt + 1 < RELEASE_CONFIRM_ATTEMPTS) await delay(RELEASE_CONFIRM_DELAY_MS);
  }
  throw cleanupError(`Tencent EIP ${before.address.AddressId ?? addressIp} release was accepted but absence is not yet confirmed`);
}

export async function describeTencentAddresses(
  env: Env,
  input: { address_id?: string | null; address_ip?: string | null; instance_id?: string | null },
): Promise<{ request_id: string | null; total_count: number; address: TencentVpcAddress | null }> {
  const addressId = normalizeEipId(input.address_id);
  const addressIp = input.address_ip ? normalizePublicIpv4(input.address_ip) : null;
  const instanceId = input.instance_id && /^eksci-[A-Za-z0-9-]+$/.test(input.instance_id) ? input.instance_id : null;
  const payload: Record<string, unknown> = { Limit: 2, Offset: 0 };
  if (addressId) payload.AddressIds = [addressId];
  else if (addressIp) payload.Filters = [{ Name: 'address-ip', Values: [addressIp] }];
  else if (instanceId) payload.Filters = [{ Name: 'instance-id', Values: [instanceId] }];
  else throw cleanupError('Tencent EIP lookup requires an exact address ID, public IPv4 address, or EKS CI instance ID');

  const response = await callTencentVpcApi(env, 'DescribeAddresses', payload);
  const addresses = response.Response?.AddressSet ?? [];
  const exact = addressId
    ? addresses.filter((address) => address.AddressId === addressId)
    : addressIp
      ? addresses.filter((address) => normalizePublicIpv4(String(address.AddressIp ?? '')) === addressIp)
      : addresses.filter((address) => address.InstanceId === instanceId);
  if (exact.length > 1) throw cleanupError('Tencent EIP lookup returned more than one exact cleanup target');
  if (!exact.length && addresses.length) throw cleanupError('Tencent EIP lookup returned a non-matching cleanup target');
  if (exact[0] && addressIp && normalizePublicIpv4(String(exact[0].AddressIp ?? '')) !== addressIp) {
    throw cleanupError('Tencent EIP ID resolved to a different public IP address');
  }
  return {
    request_id: response.Response?.RequestId ?? null,
    total_count: response.Response?.TotalCount ?? 0,
    address: exact[0] ?? null,
  };
}

async function releaseTencentAddresses(env: Env, addressIds: string[]): Promise<{ request_id: string | null; task_id: string | null }> {
  const ids = [...new Set(addressIds.map(normalizeEipId).filter((value): value is string => Boolean(value)))].slice(0, 20);
  if (!ids.length) throw cleanupError('Tencent EIP release requires a valid eip-* address ID');
  try {
    const response = await callTencentVpcApi(env, 'ReleaseAddresses', { AddressIds: ids });
    return { request_id: response.Response?.RequestId ?? null, task_id: response.Response?.TaskId ?? null };
  } catch (error) {
    if (error instanceof ProviderLaunchError && /ResourceNotFound|AddressNotFound|InvalidAddressId\.NotFound/i.test(error.provider_code ?? '')) {
      return { request_id: null, task_id: null };
    }
    throw error;
  }
}

function assertExactCleanupTarget(
  address: TencentVpcAddress,
  providerJobId: string,
  expectedAddressId: string | null,
  expectedAddressIp: string | null,
): void {
  const actualId = requiredEipId(address.AddressId);
  const actualIp = address.AddressIp ? normalizePublicIpv4(address.AddressIp) : null;
  if (expectedAddressId && actualId !== expectedAddressId) throw cleanupError('Tencent EIP ID changed during cleanup');
  if (expectedAddressIp && actualIp !== expectedAddressIp) throw cleanupError('Tencent EIP address changed during cleanup');
  if (address.AddressType && address.AddressType !== 'EIP') throw cleanupError(`refusing to release non-EIP Tencent address type=${address.AddressType}`);
  if (address.InstanceId && address.InstanceId !== providerJobId) {
    throw cleanupError(`refusing to release Tencent EIP bound to another resource ${address.InstanceId}`);
  }
  if (address.InstanceType && address.InstanceType !== 'EKS' && address.AddressStatus !== 'UNBIND' && address.AddressStatus !== 'OFFLINING') {
    throw cleanupError(`refusing to release Tencent EIP owned by instance type ${address.InstanceType}`);
  }
}

async function callTencentVpcApi(env: Env, action: string, payload: unknown): Promise<TencentVpcResponseBody> {
  const region = required(env.TENCENT_EKS_CI_REGION, 'TENCENT_EKS_CI_REGION');
  const secretId = required(env.TENCENT_SECRET_ID, 'TENCENT_SECRET_ID');
  const secretKey = required(env.TENCENT_SECRET_KEY, 'TENCENT_SECRET_KEY');
  const signed = await buildTencentTc3ServiceRequest(action, payload, region, secretId, secretKey, {
    host: TENCENT_VPC_HOST,
    service: TENCENT_VPC_SERVICE,
    version: TENCENT_VPC_VERSION,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseApiTimeout(env.TENCENT_EKS_CI_API_TIMEOUT_MS));
  try {
    const response = await fetch(TENCENT_VPC_ENDPOINT, { method: 'POST', headers: signed.headers, body: signed.body, signal: controller.signal });
    const text = await response.text();
    let body: TencentVpcResponseBody = {};
    try {
      body = text ? JSON.parse(text) as TencentVpcResponseBody : {};
    } catch {
      throw classifyProviderHttpError('tencent_eks_ci', 'parse', response.status, 'Tencent VPC returned a malformed response');
    }
    const providerError = body.Response?.Error;
    if (providerError?.Code) {
      throw classifyTencentProviderCode(providerError.Code, response.status, providerError.Message ?? providerError.Code, body.Response?.RequestId);
    }
    if (!response.ok) throw classifyProviderHttpError('tencent_eks_ci', 'provider_response', response.status, 'Tencent VPC request failed');
    return body;
  } catch (error) {
    if (error instanceof ProviderLaunchError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw classifyProviderHttpError('tencent_eks_ci', 'request', 408, 'Tencent VPC request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEipId(value: string | null | undefined): string | null {
  const candidate = String(value ?? '').trim();
  return /^eip-[A-Za-z0-9-]{1,64}$/.test(candidate) ? candidate : null;
}

function requiredEipId(value: string | null | undefined): string {
  const id = normalizeEipId(value);
  if (!id) throw cleanupError('Tencent VPC response did not contain a valid eip-* address ID');
  return id;
}

function parseApiTimeout(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_API_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_API_TIMEOUT_MS;
  return Math.max(1_000, Math.min(MAX_API_TIMEOUT_MS, Math.floor(parsed)));
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw providerConfigMissing('tencent_eks_ci', name);
  return value.trim();
}

function cleanupError(message: string): ProviderLaunchError {
  return new ProviderLaunchError({ provider: 'tencent_eks_ci', phase: 'cleanup', category: 'transient', retryable: true, safe_message: message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
