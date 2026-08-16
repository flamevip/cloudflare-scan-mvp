<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Search, SlidersHorizontal } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import JsonPanel from '@/components/JsonPanel.vue';
import { api } from '@/api/resources';
import type { AuditLog } from '@/api/contracts';
import { formatDate, safeJson, shortId } from '@/utils/format';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore(); const items = ref<AuditLog[]>([]); const loading = ref(true); const selected = ref<AuditLog | null>(null); const page = ref(1); const pageSize = 50;
const filters = reactive({ actor: '', action: '', entity_type: '', entity_id: '', project_id: '', from: '', to: '' });
onMounted(load);
async function load(): Promise<void> { loading.value = true; try { items.value = (await api.auditLogs({ page: page.value, page_size: pageSize, actor: filters.actor || undefined, action: filters.action || undefined, entity_type: filters.entity_type || undefined, entity_id: filters.entity_id || undefined, project_id: filters.project_id || undefined, from: filters.from ? new Date(filters.from).toISOString() : undefined, to: filters.to ? new Date(filters.to).toISOString() : undefined })).items; } catch (error) { ui.toast('审计日志加载失败', error instanceof Error ? error.message : '请求失败', 'danger'); } finally { loading.value = false; } }
async function apply(): Promise<void> { page.value = 1; await load(); } async function move(value: number): Promise<void> { page.value = value; await load(); }
</script>

<template>
  <PageHeader title="审计日志" description="查询身份、权限拒绝、任务和系统管理操作；日志按创建时间倒序。" eyebrow="Audit trail" />
  <form class="filter-bar" @submit.prevent="apply"><label class="field"><span>Actor</span><input v-model="filters.actor" class="input" placeholder="user_…" /></label><label class="field"><span>Action</span><input v-model="filters.action" class="input" placeholder="task.cancel" /></label><label class="field"><span>Entity type</span><input v-model="filters.entity_type" class="input" placeholder="task" /></label><label class="field"><span>Project ID</span><input v-model="filters.project_id" class="input" placeholder="project-default" /></label><label class="field"><span>开始时间</span><input v-model="filters.from" class="input" type="datetime-local" /></label><label class="field"><span>结束时间</span><input v-model="filters.to" class="input" type="datetime-local" /></label><button class="button"><Search :size="16" />查询</button></form>
  <div class="content-grid two"><div class="card"><LoadingSkeleton v-if="loading" :rows="9" /><div v-else-if="items.length" class="table-wrap"><table class="data-table"><thead><tr><th>时间</th><th>操作</th><th>Actor</th><th>实体</th></tr></thead><tbody><tr v-for="log in items" :key="log.id" style="cursor:pointer" @click="selected = log"><td class="muted">{{ formatDate(log.created_at) }}</td><td><strong>{{ log.action }}</strong></td><td class="mono">{{ shortId(log.actor) }}</td><td><div class="table-primary"><strong>{{ log.entity_type }}</strong><span>{{ shortId(log.entity_id, 12) }}</span></div></td></tr></tbody></table></div><EmptyState v-else title="没有匹配日志" /><PaginationBar :page="page" :has-next="items.length === pageSize" :loading="loading" @previous="move(page - 1)" @next="move(page + 1)" /></div><div class="card"><div class="card-header"><div><h2>事件详情</h2><p>选择左侧事件查看完整元数据</p></div><SlidersHorizontal :size="18" class="muted" /></div><div v-if="selected" class="card-body content-grid"><div class="detail-list" style="grid-template-columns:1fr 1fr"><div class="detail-item"><span>Audit ID</span><strong class="mono">{{ selected.id }}</strong></div><div class="detail-item"><span>Project</span><strong class="mono">{{ selected.project_id || 'global' }}</strong></div><div class="detail-item"><span>Action</span><strong>{{ selected.action }}</strong></div><div class="detail-item"><span>Actor</span><strong class="mono">{{ selected.actor }}</strong></div></div><JsonPanel title="metadata_json" :value="safeJson(selected.metadata_json, {})" /></div><EmptyState v-else title="请选择一条审计记录" /></div></div>
</template>
