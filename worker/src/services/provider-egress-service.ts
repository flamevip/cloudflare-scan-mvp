import type { Env } from '../env';
import { nowIso } from '../ids';

export async function recordProviderEgressIp(
  env: Env,
  taskId: string,
  agentRunId: string,
  provider: string,
  connectingIp: string | null,
): Promise<string | null> {
  if (provider !== 'tencent_eks_ci' || !connectingIp) return null;
  const ip = normalizePublicIpv4(connectingIp);
  if (!ip) return null;
  await env.DB.prepare(`
    UPDATE agent_runs SET provider_egress_ip = COALESCE(provider_egress_ip, ?), updated_at = ?
    WHERE id = ? AND task_id = ? AND provider = 'tencent_eks_ci'
      AND provider_egress_ip IS NULL
  `).bind(ip, nowIso(), agentRunId, taskId).run();
  const stored = await env.DB.prepare(`
    SELECT provider_egress_ip FROM agent_runs
    WHERE id = ? AND task_id = ? AND provider = 'tencent_eks_ci'
  `).bind(agentRunId, taskId).first<{ provider_egress_ip: string | null }>();
  return stored?.provider_egress_ip ?? null;
}

export function normalizePublicIpv4(value: string): string | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255) || parts.some((part, index) => String(octets[index]) !== part)) return null;
  const [a, b, c] = octets;
  if (
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
  ) return null;
  return octets.join('.');
}
