<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Filter, Plus, RefreshCw, ScanSearch, X } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import { api } from '@/api/resources';
import type { CreateTaskInput, Task } from '@/api/contracts';
import { formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { useRoute, useRouter } from 'vue-router';

const session = useSessionStore(); const ui = useUiStore(); const router = useRouter(); const route = useRoute();
const items = ref<Task[]>([]); const loading = ref(false); const creating = ref(false); const createOpen = ref(false);
const page = ref(1); const pageSize = 20; const projectId = ref(''); const status = ref('');
const modules = ['subdomain', 'http_probe', 'nuclei'];
const form = reactive({ name: '', project_id: '', targets: '', target_urls: '', modules: [...modules], rate_limit: 50, timeout_minutes: 30, max_cost_usd: '' });

const filtered = computed(() => status.value ? items.value.filter((item) => item.status === status.value) : items.value);
const writableProjects = computed(() => session.projects.filter((project) => session.canWriteProject(project.id)));
const canCreate = computed(() => writableProjects.value.length > 0);

onMounted(() => { const requested = typeof route.query.project_id === 'string' ? route.query.project_id : ''; projectId.value = session.projects.some((project) => project.id === requested) ? requested : ''; void load(); });
async function load(): Promise<void> { loading.value = true; try { items.value = (await api.tasks(page.value, pageSize, projectId.value || undefined)).items; } catch (error) { ui.toast('任务列表加载失败', message(error), 'danger'); } finally { loading.value = false; } }
async function move(next: number): Promise<void> { page.value = next; await load(); }
async function applyFilter(): Promise<void> { page.value = 1; await load(); }

function openCreate(): void {
  form.name = ''; form.project_id = writableProjects.value[0]?.id || ''; form.targets = session.isPilot ? '70yun.xyz' : ''; form.target_urls = '';
  form.modules = [...modules]; form.rate_limit = session.isPilot ? 1 : 50; form.timeout_minutes = session.isPilot ? 15 : 30; form.max_cost_usd = '';
  createOpen.value = true;
}

async function create(): Promise<void> {
  const targets = splitLines(form.targets); const targetUrls = splitLines(form.target_urls);
  if (!form.project_id || !targets.length) { ui.toast('请补充必填项', '项目和扫描目标不能为空。', 'danger'); return; }
  if (session.isPilot && targets.length !== 1) { ui.toast('Pilot 仅允许单目标', '请保留一个书面授权的根域名。', 'danger'); return; }
  creating.value = true;
  try {
    const payload: CreateTaskInput = {
      name: form.name.trim() || undefined, project_id: form.project_id, targets,
      target_urls: targetUrls.length ? targetUrls : undefined,
      modules: session.isPilot ? [...modules] : [...form.modules], external_sources: [], max_agents: 1,
      rate_limit: session.isPilot ? 1 : Number(form.rate_limit), timeout_minutes: session.isPilot ? 15 : Number(form.timeout_minutes),
    };
    if (form.max_cost_usd !== '') payload.max_cost_usd = Number(form.max_cost_usd);
    const created = await api.createTask(payload); createOpen.value = false; ui.toast('任务已创建', created.task_id); await router.push(`/tasks/${created.task_id}`);
  } catch (error) { ui.toast('任务创建失败', message(error), 'danger'); } finally { creating.value = false; }
}

function splitLines(value: string): string[] { return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))]; }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <PageHeader title="扫描任务" description="创建扫描、跟踪云端 Agent，并查看任务级结果。" eyebrow="Scan orchestration">
    <template #actions><button class="button secondary" :disabled="loading" @click="load"><RefreshCw :size="16" />刷新</button><button v-if="canCreate" class="button" @click="openCreate"><Plus :size="17" />新建任务</button></template>
  </PageHeader>
  <div class="filter-bar">
    <label class="field"><span>项目</span><select v-model="projectId" class="select" @change="applyFilter"><option value="">全部可访问项目</option><option v-for="project in session.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
    <label class="field"><span>当前页状态</span><select v-model="status" class="select"><option value="">全部状态</option><option v-for="option in ['pending','provisioning','running','retrying','completed','failed','timeout','cancelled']" :key="option">{{ option }}</option></select></label>
    <div class="callout" style="margin-left:auto"><Filter :size="16" /><span>状态筛选只作用于当前页</span></div>
  </div>
  <div class="card">
    <LoadingSkeleton v-if="loading" :rows="8" />
    <div v-else-if="filtered.length" class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>项目</th><th>状态</th><th>目标</th><th>结果</th><th>创建时间</th><th /></tr></thead><tbody><tr v-for="task in filtered" :key="task.id"><td><RouterLink class="table-primary link" :to="`/tasks/${task.id}`"><strong>{{ task.name }}</strong><span>{{ task.id }}</span></RouterLink></td><td class="mono">{{ task.project_id }}</td><td><StatusBadge :status="task.status" /></td><td>{{ task.target_count }}</td><td>{{ task.asset_count || 0 }} 资产 · {{ task.finding_count || 0 }} 发现</td><td class="muted">{{ formatDate(task.created_at) }}</td><td><RouterLink class="button secondary compact" :to="`/tasks/${task.id}`">详情</RouterLink></td></tr></tbody></table></div>
    <EmptyState v-else :title="status ? '当前页没有匹配任务' : '暂无扫描任务'" description="调整筛选条件，或创建一个新的扫描任务。"><button v-if="canCreate" class="button" style="margin-top:14px" @click="openCreate"><ScanSearch :size="17" />创建任务</button></EmptyState>
    <PaginationBar :page="page" :has-next="items.length === pageSize" :loading="loading" @previous="move(page - 1)" @next="move(page + 1)" />
  </div>

  <Teleport to="body"><div v-if="createOpen" class="modal-backdrop" @click.self="createOpen = false"><form class="modal-card wide" @submit.prevent="create"><button type="button" class="icon-button modal-close" aria-label="关闭" @click="createOpen = false"><X :size="18" /></button><span class="eyebrow">New scan task</span><h2>创建扫描任务</h2><p>{{ session.isPilot ? 'Pilot 安全约束已锁定，前端不会发送可绕过的参数。' : '单 Agent 执行；扫描范围仍由项目 scope 和后端校验。' }}</p>
    <div v-if="session.isPilot" class="callout warning" style="margin-bottom:16px"><ScanSearch :size="17" /><div><strong>Pilot 固定策略</strong>单目标 · rate limit 1 · 15 分钟 · 无 Hunter · 固定完整工具链</div></div>
    <div class="form-grid">
      <label class="field"><span>项目 *</span><select v-model="form.project_id" class="select" required><option v-for="project in writableProjects" :key="project.id" :value="project.id">{{ project.name }} · {{ project.membership_role }}</option></select></label>
      <label class="field"><span>任务名称</span><input v-model="form.name" class="input" maxlength="120" placeholder="70yun.xyz security scan" /></label>
      <label class="field full"><span>根域名目标 *</span><textarea v-model="form.targets" class="textarea" :disabled="false" :placeholder="session.isPilot ? '70yun.xyz' : 'example.com\nexample.org'" required /><small>{{ session.isPilot ? '只能填写一个已授权根域名' : '每行或逗号分隔一个根域名' }}</small></label>
      <label class="field full"><span>初始 URL 候选（可选）</span><textarea v-model="form.target_urls" class="textarea" placeholder="https://www.example.com/" /><small>URL 必须位于项目 scope 和目标根域名内</small></label>
      <div class="field full"><span>扫描模块</span><div class="checkbox-row"><label v-for="item in modules" :key="item" class="check-card"><input v-model="form.modules" type="checkbox" :value="item" :disabled="session.isPilot" />{{ item }}</label></div></div>
      <label class="field"><span>Rate limit</span><input v-model.number="form.rate_limit" class="input" type="number" min="1" :disabled="session.isPilot" /></label>
      <label class="field"><span>总超时（分钟）</span><input v-model.number="form.timeout_minutes" class="input" type="number" min="1" :disabled="session.isPilot" /></label>
      <label class="field full"><span>最大成本 USD（可选）</span><input v-model="form.max_cost_usd" class="input" type="number" min="0" step="0.01" placeholder="留空使用环境策略" /></label>
    </div><div class="modal-actions"><button type="button" class="button secondary" :disabled="creating" @click="createOpen = false">取消</button><button class="button" :disabled="creating">{{ creating ? '创建中…' : '创建任务' }}</button></div>
  </form></div></Teleport>
</template>
