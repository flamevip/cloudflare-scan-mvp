<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Activity, AlertTriangle, ArrowRight, Blocks, Clock3, RefreshCw, ScanSearch, ShieldCheck } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api } from '@/api/resources';
import type { OperationsSummary, Task } from '@/api/contracts';
import { formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

const session = useSessionStore(); const ui = useUiStore();
const tasks = ref<Task[]>([]); const operations = ref<OperationsSummary | null>(null); const loading = ref(true);

const running = computed(() => tasks.value.filter((t) => ['pending', 'provisioning', 'retrying', 'running'].includes(t.status)).length);
const completed = computed(() => tasks.value.filter((t) => t.status === 'completed').length);
const alerts = computed(() => operations.value?.alerts ?? []);
const metrics = computed(() => [
  { label: session.isGlobalAdmin ? '24 小时任务' : '当前页任务', value: session.isGlobalAdmin ? countRows(operations.value?.tasks_last_24h_by_status) : tasks.value.length, foot: session.isGlobalAdmin ? '全系统准确统计' : '最近可见记录', icon: ScanSearch, color: '#f48120' },
  { label: '正在运行', value: running.value, foot: '当前可见任务', icon: Activity, color: '#3b82d0' },
  { label: '已完成', value: completed.value, foot: '当前可见任务', icon: ShieldCheck, color: '#16803c' },
  { label: '运行告警', value: session.isGlobalAdmin ? alerts.value.length : '—', foot: session.isGlobalAdmin ? (operations.value?.health || '检查中') : '仅管理员可见', icon: AlertTriangle, color: '#c23030' },
]);

onMounted(load);
async function load(): Promise<void> {
  loading.value = true;
  try {
    const requests: [Promise<{ items: Task[] }>, Promise<OperationsSummary | null>] = [api.tasks(1, 8), session.isGlobalAdmin ? api.operations() : Promise.resolve(null)];
    const [taskPage, summary] = await Promise.all(requests); tasks.value = taskPage.items; operations.value = summary;
  } catch (error) { ui.toast('概览加载失败', error instanceof Error ? error.message : '请求失败', 'danger'); }
  finally { loading.value = false; }
}
function countRows(rows?: Array<{ count: number }>): number { return rows?.reduce((sum, item) => sum + Number(item.count), 0) ?? 0; }
</script>

<template>
  <PageHeader title="安全运行概览" :description="session.isGlobalAdmin ? '汇总最近 24 小时任务、Agent 与基础设施信号。' : '查看你有权访问的项目和最近扫描任务。'" eyebrow="Workspace overview">
    <template #actions><button class="button secondary" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button><RouterLink v-if="session.hasScope('tasks:read')" to="/tasks" class="button">查看任务<ArrowRight :size="16" /></RouterLink></template>
  </PageHeader>
  <LoadingSkeleton v-if="loading" :rows="6" />
  <template v-else>
    <section class="metrics-grid"><article v-for="metric in metrics" :key="metric.label" class="metric-card" :style="{ '--metric-color': metric.color }"><div class="metric-top"><span>{{ metric.label }}</span><span class="metric-icon"><component :is="metric.icon" :size="17" /></span></div><strong class="metric-value">{{ metric.value }}</strong><span class="metric-foot">{{ metric.foot }}</span></article></section>
    <section class="content-grid two">
      <div class="card"><div class="card-header"><div><h2>最近任务</h2><p>按创建时间倒序</p></div><RouterLink class="link" to="/tasks">全部任务</RouterLink></div><div v-if="tasks.length" class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>状态</th><th>结果</th><th>创建时间</th></tr></thead><tbody><tr v-for="task in tasks" :key="task.id"><td><RouterLink class="table-primary link" :to="`/tasks/${task.id}`"><strong>{{ task.name }}</strong><span>{{ task.id }}</span></RouterLink></td><td><StatusBadge :status="task.status" /></td><td>{{ task.asset_count || 0 }} 资产 · {{ task.finding_count || 0 }} 发现</td><td class="muted">{{ formatDate(task.created_at) }}</td></tr></tbody></table></div><EmptyState v-else title="暂无扫描任务" description="创建首个任务后，最新运行状态会显示在这里。" /></div>
      <div class="content-grid">
        <div v-if="session.isGlobalAdmin" class="card"><div class="card-header"><div><h2>运行告警</h2><p>Provider、超时与死信信号</p></div><StatusBadge :status="operations?.health" /></div><div class="card-body content-grid"><div v-for="alert in alerts" :key="alert.code" class="callout" :class="alert.severity === 'critical' ? 'danger' : 'warning'"><AlertTriangle :size="17" /><div><strong>{{ alert.code }}</strong>{{ alert.message || `命中 ${alert.count ?? alert.value ?? 0} 条运行信号` }}</div></div><EmptyState v-if="!alerts.length" title="运行状态正常" description="当前没有需要处理的运行告警。" /></div></div>
        <div class="card"><div class="card-header"><div><h2>可访问项目</h2><p>当前 Token 的项目边界</p></div><Blocks :size="18" class="muted" /></div><div class="card-body content-grid"><RouterLink v-for="project in session.projects" :key="project.id" to="/projects" class="run-card" style="display:flex;align-items:center;justify-content:space-between"><div><strong>{{ project.name }}</strong><div class="muted mono">{{ project.id }}</div></div><StatusBadge :status="project.membership_role" /></RouterLink><EmptyState v-if="!session.projects.length" title="没有项目权限" /></div></div>
      </div>
    </section>
  </template>
</template>
