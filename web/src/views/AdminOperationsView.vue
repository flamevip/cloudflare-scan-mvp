<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Activity, AlertTriangle, CloudCog, Database, RefreshCw, Send, TimerReset, Trash2, X } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import JsonPanel from '@/components/JsonPanel.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import { api } from '@/api/resources';
import type { OperationsSummary, ProviderPreflightInput } from '@/api/contracts';
import { formatDate } from '@/utils/format';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore(); const summary = ref<OperationsSummary | null>(null); const loading = ref(true); const busy = ref(false);
const preflight = ref<Record<string, unknown> | null>(null); const searchStatus = ref<Record<string, unknown> | null>(null); const maintenanceResult = ref<Record<string, unknown> | null>(null); const retentionPreview = ref<Record<string, unknown> | null>(null);
const confirmAction = ref<'' | 'canary' | 'timeouts'>(''); const retentionOpen = ref(false); const retentionPhrase = ref('');
const preflightForm = reactive({ target: '70yun.xyz', cloud_check: false, rate_limit: 1, timeout_minutes: 15, max_cost_usd: '5' });
const metrics = computed(() => summary.value ? [
  { label: '24h Agent Runs', value: summary.value.agent_runs_last_24h_total, color: '#3b82d0' },
  { label: '失败或超时', value: summary.value.agent_runs_last_24h_failed_or_timeout, color: '#c23030' },
  { label: '失联心跳', value: summary.value.stale_agent_heartbeats, color: '#ed8b25' },
  { label: '待清理实例', value: summary.value.provider_cleanup_pending, color: '#f48120' },
] : []);

onMounted(loadSummary);
async function loadSummary(): Promise<void> { loading.value = true; try { summary.value = await api.operations(); } catch (error) { ui.toast('运维摘要加载失败', message(error), 'danger'); } finally { loading.value = false; } }
async function runPreflight(): Promise<void> { busy.value = true; try { const body: ProviderPreflightInput = { provider: 'tencent_eks_ci', targets: [preflightForm.target.trim()], modules: ['subdomain', 'http_probe', 'nuclei'], rate_limit: Number(preflightForm.rate_limit), timeout_minutes: Number(preflightForm.timeout_minutes), max_cost_usd: preflightForm.max_cost_usd === '' ? null : Number(preflightForm.max_cost_usd), cloud_check: preflightForm.cloud_check }; preflight.value = await api.providerPreflight(body); ui.toast('Provider preflight 已完成'); } catch (error) { ui.toast('Preflight 失败', message(error), 'danger'); } finally { busy.value = false; } }
async function loadSearchStatus(): Promise<void> { busy.value = true; try { searchStatus.value = await api.searchStatus(); ui.toast('Search 状态已更新'); } catch (error) { ui.toast('Search 状态读取失败', message(error), 'danger'); } finally { busy.value = false; } }
async function runConfirmed(): Promise<void> { busy.value = true; try { if (confirmAction.value === 'canary') maintenanceResult.value = await api.consumerCanary(); else maintenanceResult.value = await api.sweepTimeouts(); ui.toast(confirmAction.value === 'canary' ? 'Queue canary 已入队' : '超时收敛已完成'); confirmAction.value = ''; await loadSummary(); } catch (error) { ui.toast('运维操作失败', message(error), 'danger'); } finally { busy.value = false; } }
async function previewRetention(): Promise<void> { busy.value = true; try { retentionPreview.value = await api.retention(true); ui.toast('Retention 预览已生成', '未删除任何数据。'); } catch (error) { ui.toast('Retention 预览失败', message(error), 'danger'); } finally { busy.value = false; } }
async function executeRetention(): Promise<void> { if (retentionPhrase.value !== 'EXECUTE RETENTION') return; busy.value = true; try { maintenanceResult.value = await api.retention(false); retentionOpen.value = false; retentionPhrase.value = ''; retentionPreview.value = null; ui.toast('Retention 清理已执行'); await loadSummary(); } catch (error) { ui.toast('Retention 执行失败', message(error), 'danger'); } finally { busy.value = false; } }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <PageHeader title="运维中心" description="集中处理 Provider 预检、Queue 链路、超时收敛、Search 状态和数据保留。" eyebrow="Operations"><template #actions><StatusBadge v-if="summary" :status="summary.health" /><button class="button secondary" @click="loadSummary"><RefreshCw :size="16" />刷新摘要</button></template></PageHeader>
  <LoadingSkeleton v-if="loading" :rows="6" />
  <template v-else>
    <section class="metrics-grid"><article v-for="metric in metrics" :key="metric.label" class="metric-card" :style="{ '--metric-color': metric.color }"><div class="metric-top"><span>{{ metric.label }}</span><span class="metric-icon"><Activity :size="17" /></span></div><strong class="metric-value">{{ metric.value }}</strong><span class="metric-foot">最近 24 小时 / 当前状态</span></article></section>
    <div v-if="summary?.alerts.length" class="content-grid" style="margin-bottom:18px"><div v-for="alert in summary.alerts" :key="alert.code" class="callout" :class="alert.severity === 'critical' ? 'danger' : 'warning'"><AlertTriangle :size="17" /><div><strong>{{ alert.code }}</strong>{{ alert.message }}</div></div></div>
    <section class="content-grid two">
      <div class="card"><div class="card-header"><div><h2>腾讯 EKS CI Preflight</h2><p>默认只生成计划；Cloud check 仅执行只读 Describe</p></div><CloudCog :size="19" class="muted" /></div><form class="card-body form-grid" @submit.prevent="runPreflight"><label class="field full"><span>授权目标</span><input v-model="preflightForm.target" class="input" required /></label><label class="field"><span>Rate limit</span><input v-model.number="preflightForm.rate_limit" class="input" type="number" min="1" /></label><label class="field"><span>Timeout minutes</span><input v-model.number="preflightForm.timeout_minutes" class="input" type="number" min="1" /></label><label class="field"><span>最大费用 USD</span><input v-model="preflightForm.max_cost_usd" class="input" type="number" min="0" step="0.01" /></label><label class="check-card" style="align-self:end"><input v-model="preflightForm.cloud_check" type="checkbox" />执行腾讯只读 Cloud check</label><div class="field full"><button class="button" :disabled="busy"><CloudCog :size="16" />执行 Preflight</button></div></form><div v-if="preflight" class="card-body" style="padding-top:0"><JsonPanel title="Preflight result" :value="preflight" /></div></div>
      <div class="content-grid">
        <div class="card"><div class="card-header"><div><h2>运行维护</h2><p>操作会写入结构化日志和审计记录</p></div><TimerReset :size="19" class="muted" /></div><div class="card-body content-grid"><button class="button secondary" @click="confirmAction = 'canary'"><Send :size="16" />发送 Queue consumer canary</button><button class="button secondary" @click="confirmAction = 'timeouts'"><TimerReset :size="16" />立即执行超时收敛</button><button class="button secondary" @click="loadSearchStatus"><Database :size="16" />读取 AI Search 状态</button></div></div>
        <div class="card"><div class="card-header"><div><h2>数据保留清理</h2><p>全局扫描所有项目，必须先预览</p></div><Trash2 :size="19" class="muted" /></div><div class="card-body content-grid"><div class="callout warning"><AlertTriangle :size="17" /><span>R2 删除成功后才删除 D1 Artifact 记录；失败项保留并等待下次重试。</span></div><button class="button secondary" :disabled="busy" @click="previewRetention"><Database :size="16" />生成 Dry-run 预览</button><button class="button danger" :disabled="!retentionPreview || busy" @click="retentionOpen = true"><Trash2 :size="16" />执行正式清理</button></div><div v-if="retentionPreview" class="card-body" style="padding-top:0"><JsonPanel title="Retention dry-run" :value="retentionPreview" /></div></div>
      </div>
    </section>
    <section v-if="searchStatus || maintenanceResult" class="content-grid two" style="margin-top:18px"><JsonPanel v-if="searchStatus" title="AI Search status" :value="searchStatus" /><JsonPanel v-if="maintenanceResult" title="Latest maintenance result" :value="maintenanceResult" /></section>
    <div v-if="summary" class="card" style="margin-top:18px"><div class="card-header"><div><h2>完整运行摘要</h2><p>生成于 {{ formatDate(summary.generated_at) }}</p></div></div><div class="card-body"><JsonPanel :value="summary" /></div></div>
  </template>
  <ConfirmDialog :open="Boolean(confirmAction)" :title="confirmAction === 'canary' ? '发送 Queue canary？' : '立即执行超时收敛？'" :description="confirmAction === 'canary' ? '系统会向生产 Queue 写入一条 canary 消息，用于验证 consumer 链路。' : '系统会立即检查运行中的任务和 Agent 心跳，并将符合条件的记录收敛为 timeout。'" :confirm-label="confirmAction === 'canary' ? '确认发送' : '确认执行'" :busy="busy" @close="confirmAction = ''" @confirm="runConfirmed" />
  <Teleport to="body"><div v-if="retentionOpen" class="modal-backdrop" @click.self="retentionOpen = false"><form class="modal-card confirm-card" @submit.prevent="executeRetention"><button type="button" class="icon-button modal-close" @click="retentionOpen = false"><X :size="18" /></button><div class="dialog-icon danger"><Trash2 :size="21" /></div><h2>执行全局 Retention 清理</h2><p>这会依据各项目策略删除过期 R2 对象及关联元数据，操作不可撤销。请输入 <code>EXECUTE RETENTION</code> 确认。</p><label class="field"><span>确认词</span><input v-model="retentionPhrase" class="input mono" autocomplete="off" /></label><div class="modal-actions"><button type="button" class="button secondary" @click="retentionOpen = false">返回</button><button class="button danger" :disabled="retentionPhrase !== 'EXECUTE RETENTION' || busy">确认永久清理</button></div></form></div></Teleport>
</template>
