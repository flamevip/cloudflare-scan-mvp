import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const region = required('TENCENT_EKS_CI_REGION');
const secretId = required('TENCENT_SECRET_ID');
const secretKey = required('TENCENT_SECRET_KEY');
const reportPath = process.env.ACCEPTANCE_REPORT_PATH?.trim() || 'work/console-cloud-acceptance.json';

let report = {};
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

try {
  const [eks, eip] = await Promise.all([
    callTencentApi({ host: 'tke.tencentcloudapi.com', service: 'tke', version: '2018-05-25' }, 'DescribeEKSContainerInstances', { Limit: 100, Offset: 0 }),
    callTencentApi({ host: 'vpc.tencentcloudapi.com', service: 'vpc', version: '2017-03-12' }, 'DescribeAddresses', { Limit: 100, Offset: 0 }),
  ]);
  const eksResponse = eks.Response ?? {};
  const eipResponse = eip.Response ?? {};
  const inventory = {
    checked_at: new Date().toISOString(),
    region,
    eks_instance_count: Number(eksResponse.TotalCount ?? 0),
    eip_count: Number(eipResponse.TotalCount ?? 0),
    eks_request_id: eksResponse.RequestId ?? null,
    eip_request_id: eipResponse.RequestId ?? null,
    nonzero_samples: {
      eks: (eksResponse.EksCis ?? []).slice(0, 10).map((item) => ({ id: item.EksCiId ?? null, name: item.EksCiName ?? null, status: item.Status ?? null })),
      eip: (eipResponse.AddressSet ?? []).slice(0, 10).map((item) => ({ id: item.AddressId ?? null, ip: item.AddressIp ?? null, status: item.AddressStatus ?? null, instance_id: item.InstanceId ?? null })),
    },
  };
  report.cloud_resources = inventory;
  await saveReport(reportPath, report);
  console.log(JSON.stringify({ event: 'console.acceptance.tencent_inventory', region, eks_instance_count: inventory.eks_instance_count, eip_count: inventory.eip_count }));
  assert.equal(inventory.eks_instance_count, 0, `Tencent EKS CI inventory is not empty: ${inventory.eks_instance_count}`);
  assert.equal(inventory.eip_count, 0, `Tencent EIP inventory is not empty: ${inventory.eip_count}`);
} catch (error) {
  report.cloud_resources = {
    ...(report.cloud_resources ?? {}),
    checked_at: new Date().toISOString(),
    region,
    error: safeError(error),
  };
  await saveReport(reportPath, report);
  throw error;
}

async function callTencentApi(endpoint, action, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${endpoint.host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
  const credentialScope = `${date}/${endpoint.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256(canonicalRequest)].join('\n');
  const secretDate = hmac(Buffer.from(`TC3${secretKey}`, 'utf8'), date);
  const secretService = hmac(secretDate, endpoint.service);
  const secretSigning = hmac(secretService, 'tc3_request');
  const signature = hmac(secretSigning, stringToSign).toString('hex');
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${endpoint.host}/`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      Host: endpoint.host,
      'X-TC-Action': action,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': endpoint.version,
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Response?.Error) {
    const code = result.Response?.Error?.Code ?? `HTTP ${response.status}`;
    const message = result.Response?.Error?.Message ?? 'Tencent API request failed';
    throw new Error(`${action} failed: ${code}: ${message}`);
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

async function saveReport(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .split(secretId).join('[redacted]')
    .split(secretKey).join('[redacted]')
    .replace(/(SecretId|SecretKey|Authorization|Credential)=?[^\s,]*/gi, '$1=[redacted]')
    .slice(0, 1000);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
