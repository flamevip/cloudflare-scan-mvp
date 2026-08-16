<script setup lang="ts">
import { reactive, ref } from 'vue';
import { Database, FileSearch, Search, Sparkles } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import EmptyState from '@/components/EmptyState.vue';
import JsonPanel from '@/components/JsonPanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/api/resources';
import type { SearchResponse } from '@/api/contracts';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';
import { shortId } from '@/utils/format';

const session = useSessionStore(); const ui = useUiStore();
const form = reactive({ q: '', task_id: '', type: '', limit: 10 }); const loading = ref(false); const searched = ref(false); const result = ref<SearchResponse | null>(null);
async function search(): Promise<void> { if (!form.q.trim()) return; loading.value = true; try { result.value = await api.search({ q: form.q.trim(), task_id: form.task_id.trim() || undefined, type: form.type.trim() || undefined, limit: form.limit }); searched.value = true; } catch (error) { ui.toast('搜索失败', error instanceof Error ? error.message : '请求失败', 'danger'); } finally { loading.value = false; } }
</script>

<template>
  <PageHeader title="AI Search" description="在授权范围内查询 Agent 生成的 Search 文档；索引未就绪时自动使用近期 R2 文档回退。" eyebrow="Authorized artifact search" />
  <form class="card" @submit.prevent="search"><div class="card-body form-grid"><label class="field full"><span>搜索内容</span><div style="display:flex;gap:8px"><input v-model="form.q" class="input" maxlength="500" placeholder="例如：login、TLS certificate、CVE" autofocus /><button class="button" :disabled="loading || !form.q.trim()"><Search :size="17" />{{ loading ? '搜索中…' : '搜索' }}</button></div></label><label class="field"><span>限定任务（可选）</span><input v-model="form.task_id" class="input" placeholder="task_…" /></label><label class="field"><span>产物类型（可选）</span><input v-model="form.type" class="input" pattern="[a-zA-Z0-9_-]+" placeholder="agent_real_toolchain_raw" /></label><label class="field"><span>返回数量</span><input v-model.number="form.limit" class="input" type="number" min="1" max="20" /></label></div></form>
  <section v-if="result" class="content-grid" style="margin-top:18px">
    <div class="callout" :class="result.degraded ? 'warning' : ''"><Database :size="18" /><div><strong>{{ result.degraded ? '搜索服务降级' : '搜索完成' }}</strong>{{ result.degraded ? (result.message || 'AI Search 当前不可用') : `返回 ${result.items.length} 条已授权结果。` }}</div><StatusBadge style="margin-left:auto" :status="result.degraded ? 'warning' : String(result.metadata.indexing_state || 'ok')" /></div>
    <div class="content-grid two">
      <div class="content-grid"><article v-for="item in result.items" :key="String(item.artifact_id || JSON.stringify(item))" class="card"><div class="card-header"><div><h3>{{ item.type || 'Search document' }}</h3><p>{{ shortId(item.artifact_id, 12) }} · {{ shortId(item.task_id, 12) }}</p></div><StatusBadge :status="String(item.source || 'indexed')" /></div><div class="card-body"><p style="white-space:pre-wrap;word-break:break-word">{{ item.text || '结果未携带文本摘要，可在任务产物中查看原始文件。' }}</p><div v-if="item.score !== null && item.score !== undefined" class="muted">相关度：{{ item.score }}</div><RouterLink v-if="item.task_id" class="link" :to="`/tasks/${item.task_id}`">打开任务 →</RouterLink></div></article><EmptyState v-if="!result.items.length" title="没有匹配的授权文档" description="这可能是索引仍在构建、关键词未命中，或过期结果已被 D1 权限映射过滤。" /></div>
      <JsonPanel title="Search metadata" :value="result.metadata" />
    </div>
  </section>
  <EmptyState v-else-if="!searched" title="搜索扫描产物" description="输入关键词，并可选择限定到某个任务或产物类型。"><Sparkles :size="18" style="margin-top:12px" /></EmptyState>
</template>
