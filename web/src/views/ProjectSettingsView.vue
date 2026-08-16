<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Archive, Database, History, Save } from 'lucide-vue-next';
import { useRoute } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import { api } from '@/api/resources';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

const route = useRoute(); const session = useSessionStore(); const ui = useUiStore(); const projectId = String(route.params.id); const saving = ref(false);
const project = computed(() => session.projects.find((item) => item.id === projectId)); const form = reactive({ artifact: 30, metadata: 180, audit: 180 });
onMounted(() => { if (project.value) { form.artifact = project.value.artifact_retention_days ?? 30; form.metadata = project.value.metadata_retention_days ?? 180; form.audit = project.value.audit_retention_days ?? 180; } });
async function save(): Promise<void> { saving.value = true; try { await api.saveProjectSettings(projectId, { artifact_retention_days: form.artifact, metadata_retention_days: form.metadata, audit_retention_days: form.audit }); await session.loadProjects(); ui.toast('保留策略已更新', '新的周期只影响后续保留清理。'); } catch (error) { ui.toast('保存失败', error instanceof Error ? error.message : '请求失败', 'danger'); } finally { saving.value = false; } }
</script>

<template>
  <PageHeader :title="`${project?.name || projectId} · 保留策略`" description="项目级策略只能缩短系统默认值；R2 删除成功后才会删除 Artifact 元数据。" eyebrow="Data lifecycle" />
  <form class="content-grid" @submit.prevent="save"><div class="content-grid two"><label class="project-card"><div class="project-head"><div><h2>原始产物</h2><p>R2 raw 与 search 文档</p></div><Archive :size="20" class="muted" /></div><input v-model.number="form.artifact" class="input" type="number" min="1" max="30" required /><span class="muted">允许 1–30 天，系统默认 30 天。</span></label><label class="project-card"><div class="project-head"><div><h2>任务元数据</h2><p>任务、运行、资产和发现项</p></div><Database :size="20" class="muted" /></div><input v-model.number="form.metadata" class="input" type="number" min="30" max="180" required /><span class="muted">允许 30–180 天，系统默认 180 天。</span></label><label class="project-card"><div class="project-head"><div><h2>审计日志</h2><p>授权与管理操作记录</p></div><History :size="20" class="muted" /></div><input v-model.number="form.audit" class="input" type="number" min="30" max="180" required /><span class="muted">允许 30–180 天，系统默认 180 天。</span></label></div><div class="callout warning"><History :size="17" /><div><strong>缩短保留时间可能触发不可恢复的数据删除</strong>保存配置本身不会立即执行清理；正式 Retention 操作仍需在运维中心先预览并二次确认。</div></div><div><button class="button" :disabled="saving"><Save :size="16" />{{ saving ? '保存中…' : '保存保留策略' }}</button></div></form>
</template>
