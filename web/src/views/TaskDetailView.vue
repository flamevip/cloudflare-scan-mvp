<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Ban, Clock3, Download, RefreshCw, ShieldAlert } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import EmptyState from '@/components/EmptyState.vue';
import JsonPanel from '@/components/JsonPanel.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { api } from '@/api/resources';
import { downloadArtifact } from '@/api/client';
import type { AgentRun, Artifact, Asset, Finding, Task, TaskShard } from '@/api/contracts';
import { formatBytes, formatDate, formatDuration, safeJson, shortId } from '@/utils/format';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

const route = useRoute(); const session = useSessionStore(); const ui = useUiStore();
const id = String(route.params.id); const task = ref<Task | null>(null); const shards = ref<TaskShard[]>([]); const runs = ref<AgentRun[]>([]); const assets = ref<Asset[]>([]); const findings = ref<Finding[]>([]); const artifacts = ref<Artifact[]>([]);
const loading = ref(true); const refreshing = ref(false); const cancelOpen = ref(false); const cancelling = ref(false); const activeTab = ref('overview');
let controller: AbortController | null = null; let timer: number | null = null;
const terminal = computed(() => task.value ? ['completed', 'failed', 'timeout', 'cancelled'].includes(task.value.status) : true);
const canCancel = computed(() => Boolean(task.value && !terminal.value && session.canWriteProject(task.value.project_id)));
const canReadArtifacts = computed(() => session.hasScope('artifacts:read'));
const targets = computed(() => safeJson<string[]>(task.value?.targets_json, [])); const modules = computed(() => safeJson<string[]>(task.value?.modules_json, []));
const tabs = computed(() => [
  { id: 'overview', label: '概览' }, { id: 'shards', label: `Shard (${shards.value.length})` }, { id: 'runs', label: `Agent Run (${runs.value.length})` },
  { id: 'assets', label: `Assets (${assets.value.length})` }, { id: 'findings', label: `Findings (${findings.value.length})` },
  ...(canReadArtifacts.value ? [{ id: 'artifacts', label: `Artifacts (${artifacts.value.length})` }] : []),
]);

onMounted(async () => { await load(); schedule(); document.addEventListener('visibilitychange', visibilityChanged); });
onBeforeUnmount(() => { stop(); controller?.abort(); document.removeEventListener('visibilitychange', visibilityChanged); });
function visibilityChanged(): void { if (document.hidden) stop(); else schedule(); }
function schedule(): void { stop(); if (!terminal.value && !document.hidden) timer = window.setInterval(() => void load(true), 10_000); }
function stop(): void { if (timer !== null) window.clearInterval(timer); timer = null; }

async function load(background = false): Promise<void> {
  if (background) refreshing.value = true; else loading.value = true;
  controller?.abort(); controller = new AbortController();
  try {
    const signal = controller.signal;
    const [taskData, shardData, runData, assetData, findingData, artifactData] = await Promise.all([
      api.task(id, signal), api.shards(id, signal), api.agentRuns(id, signal), api.assets(id, signal), api.findings(id, signal),
      canReadArtifacts.value ? api.artifacts(id, signal) : Promise.resolve({ items: [] as Artifact[] }),
    ]);
    task.value = taskData; shards.value = shardData.items; runs.value = runData.items; assets.value = assetData.items; findings.value = findingData.items; artifacts.value = artifactData.items;
    if (terminal.value) stop();
  } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) ui.toast('任务详情加载失败', message(error), 'danger'); }
  finally { loading.value = false; refreshing.value = false; }
}

async function cancelTask(): Promise<void> { cancelling.value = true; try { await api.cancelTask(id); cancelOpen.value = false; ui.toast('任务已取消', 'Provider 清理已触发，并将由定时任务继续收敛。'); await load(true); } catch (error) { ui.toast('取消失败', message(error), 'danger'); } finally { cancelling.value = false; } }
async function download(idValue: string, kind: 'raw' | 'search'): Promise<void> { try { await downloadArtifact(idValue, kind); ui.toast('下载已开始'); } catch (error) { ui.toast('下载失败', message(error), 'danger'); } }
function events(run: AgentRun): unknown { return safeJson<unknown[]>(run.provider_events_json, []); }
function technologies(asset: Asset): string { return safeJson<string[]>(asset.technologies_json, []).join(', ') || '—'; }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <LoadingSkeleton v-if="loading" :rows="9" />
  <template v-else-if="task">
    <PageHeader :title="task.name" :description="`${task.project_id} · ${task.id}`" eyebrow="Task details">
      <template #actions><StatusBadge :status="task.status" /><button class="button secondary" :disabled="refreshing" @click="load(true)"><RefreshCw :size="16" :class="{ spin: refreshing }" />刷新</button><button v-if="canCancel" class="button danger" @click="cancelOpen = true"><Ban :size="16" />取消任务</button></template>
    </PageHeader>
    <div v-if="task.error_message" class="callout danger" style="margin-bottom:16px"><ShieldAlert :size="18" /><div><strong>任务错误</strong>{{ task.error_message }}</div></div>
    <div class="card"><div class="tabs" role="tablist"><button v-for="tab in tabs" :key="tab.id" class="tab-button" :class="{ active: activeTab === tab.id }" @click="activeTab = tab.id">{{ tab.label }}</button></div>
      <div class="card-body">
        <section v-if="activeTab === 'overview'" class="content-grid">
          <div class="detail-list"><div class="detail-item"><span>状态</span><StatusBadge :status="task.status" /></div><div class="detail-item"><span>创建时间</span><strong>{{ formatDate(task.created_at) }}</strong></div><div class="detail-item"><span>运行窗口</span><strong>{{ formatDate(task.started_at) }} → {{ formatDate(task.finished_at) }}</strong></div><div class="detail-item"><span>结果</span><strong>{{ task.asset_count || 0 }} 资产 · {{ task.finding_count || 0 }} 发现 · {{ task.artifact_count || 0 }} 产物</strong></div><div class="detail-item"><span>执行限制</span><strong>{{ task.max_agents }} Agent · {{ task.rate_limit }}/s · {{ task.timeout_minutes }} min</strong></div><div class="detail-item"><span>创建人</span><strong>{{ task.created_by }}</strong></div></div>
          <div class="content-grid two"><div class="card"><div class="card-header"><h3>授权目标</h3></div><div class="card-body checkbox-row"><span v-for="target in targets" :key="target" class="status-badge tone-info">{{ target }}</span><span v-if="!targets.length" class="muted">无</span></div></div><div class="card"><div class="card-header"><h3>工具链模块</h3></div><div class="card-body checkbox-row"><span v-for="module in modules" :key="module" class="status-badge">{{ module }}</span></div></div></div>
          <div v-if="!terminal" class="callout"><Clock3 :size="17" /><div><strong>实时更新中</strong>此页面每 10 秒刷新一次；切换标签页或任务进入终态后停止轮询。</div></div>
        </section>

        <section v-else-if="activeTab === 'shards'"><div v-if="shards.length" class="table-wrap"><table class="data-table"><thead><tr><th>Shard</th><th>模块</th><th>状态</th><th>目标</th><th>重试</th><th>Agent Run</th><th>时间</th></tr></thead><tbody><tr v-for="shard in shards" :key="shard.id"><td class="mono">{{ shortId(shard.id) }}</td><td>{{ shard.module }}</td><td><StatusBadge :status="shard.status" /></td><td>{{ shard.target_count }}</td><td>{{ shard.retry_count }} / {{ shard.max_retry }}</td><td class="mono">{{ shortId(shard.agent_run_id) }}</td><td class="muted">{{ formatDate(shard.started_at) }}</td></tr></tbody></table></div><EmptyState v-else title="尚未创建 Shard" /></section>

        <section v-else-if="activeTab === 'runs'"><article v-for="run in runs" :key="run.id" class="run-card"><div class="run-head"><div><h3>{{ run.provider }} · {{ shortId(run.id) }}</h3><p>{{ run.region || 'unknown region' }} · {{ run.provider_job_id || '尚未获得实例 ID' }}</p></div><StatusBadge :status="run.status" /></div><div class="detail-list"><div class="detail-item"><span>出口 IP</span><strong>{{ run.provider_egress_ip || '待分配/未记录' }}</strong></div><div class="detail-item"><span>心跳</span><strong>{{ formatDate(run.last_heartbeat_at) }}</strong></div><div class="detail-item"><span>执行时间</span><strong>{{ formatDuration(run.duration_seconds) }}</strong></div><div class="detail-item"><span>容器状态</span><strong>{{ run.provider_container_state || run.provider_status || '—' }}</strong></div><div class="detail-item"><span>退出码</span><strong>{{ run.provider_exit_code ?? run.exit_code ?? '—' }}</strong></div><div class="detail-item"><span>清理</span><strong>{{ run.provider_cleanup_completed_at ? '已完成' : `${run.provider_cleanup_attempts || 0} 次尝试` }}</strong></div></div><div v-if="run.error_message || run.provider_status_message || run.provider_cleanup_last_error" class="callout danger" style="margin-top:14px"><ShieldAlert :size="17" /><div><strong>{{ run.provider_status_reason || '运行诊断' }}</strong>{{ run.error_message || run.provider_status_message || run.provider_cleanup_last_error }}</div></div><div class="run-diagnostics"><JsonPanel title="Provider events（已限长并脱敏）" :value="events(run)" /></div></article><EmptyState v-if="!runs.length" title="尚无 Agent Run" description="Queue consumer 接管任务后，云端实例信息会显示在这里。" /></section>

        <section v-else-if="activeTab === 'assets'"><div v-if="assets.length" class="table-wrap"><table class="data-table"><thead><tr><th>URL / Host</th><th>状态</th><th>IP</th><th>端口</th><th>技术栈</th><th>发现时间</th></tr></thead><tbody><tr v-for="asset in assets" :key="asset.id"><td><a v-if="asset.url" class="table-primary link" :href="asset.url" target="_blank" rel="noopener noreferrer"><strong>{{ asset.title || asset.host || asset.url }}</strong><span>{{ asset.url }}</span></a><div v-else class="table-primary"><strong>{{ asset.host || '—' }}</strong><span>{{ asset.type }}</span></div></td><td><StatusBadge :status="asset.status_code ? String(asset.status_code) : asset.type" /></td><td class="mono">{{ asset.ip || '—' }}</td><td>{{ asset.port || '—' }}</td><td>{{ technologies(asset) }}</td><td class="muted">{{ formatDate(asset.created_at) }}</td></tr></tbody></table></div><EmptyState v-else title="暂无资产" /></section>

        <section v-else-if="activeTab === 'findings'"><div v-if="findings.length" class="table-wrap"><table class="data-table"><thead><tr><th></th><th>发现项</th><th>等级</th><th>模板</th><th>资产</th><th>时间</th></tr></thead><tbody><tr v-for="finding in findings" :key="finding.id"><td><div class="severity-bar" :class="finding.severity.toLowerCase()" /></td><td><div class="table-primary"><strong>{{ finding.title }}</strong><span>{{ finding.id }}</span></div></td><td><StatusBadge :status="finding.severity" /></td><td class="mono">{{ finding.template_id || '—' }}</td><td>{{ finding.asset_host || finding.asset_url || '—' }}</td><td class="muted">{{ formatDate(finding.matched_at || finding.created_at) }}</td></tr></tbody></table></div><EmptyState v-else title="暂无安全发现" description="发现数量允许为 0；原始工具链产物仍应在 Artifacts 中生成。" /></section>

        <section v-else-if="activeTab === 'artifacts'"><div v-if="artifacts.length" class="table-wrap"><table class="data-table"><thead><tr><th>产物</th><th>类型</th><th>大小</th><th>SHA-256</th><th>创建时间</th><th>下载</th></tr></thead><tbody><tr v-for="artifact in artifacts" :key="artifact.id"><td><div class="table-primary"><strong>{{ shortId(artifact.id, 12) }}</strong><span>{{ artifact.raw_r2_key }}</span></div></td><td><StatusBadge :status="artifact.type" /></td><td>{{ formatBytes(artifact.size) }}</td><td class="mono">{{ shortId(artifact.sha256, 12) }}</td><td class="muted">{{ formatDate(artifact.created_at) }}</td><td><div class="table-actions"><button class="button secondary compact" @click="download(artifact.id, 'raw')"><Download :size="14" />Raw</button><button v-if="artifact.search_r2_key" class="button secondary compact" @click="download(artifact.id, 'search')"><Download :size="14" />Search</button></div></td></tr></tbody></table></div><EmptyState v-else title="暂无产物" /></section>
      </div>
    </div>
    <ConfirmDialog :open="cancelOpen" title="取消扫描任务？" description="任务、Shard 和运行中的 Agent Run 将进入 cancelled；腾讯实例清理会立即触发并由定时任务兜底。迟到回调将被拒绝。" confirm-label="确认取消" dangerous :busy="cancelling" @close="cancelOpen = false" @confirm="cancelTask" />
  </template>
</template>
