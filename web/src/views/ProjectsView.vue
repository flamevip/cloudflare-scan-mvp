<script setup lang="ts">
import { onMounted } from 'vue';
import { Clock3, Settings2, Users } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useSessionStore } from '@/stores/session';
import { safeJson } from '@/utils/format';
const session = useSessionStore();
onMounted(() => session.loadProjects());
function scope(value: string): string { const items = safeJson<string[]>(value, []); return items.length ? items.join(' · ') : '未配置授权根域名'; }
</script>

<template>
  <PageHeader title="项目与授权边界" description="项目决定扫描目标范围、成员权限和数据保留周期。" eyebrow="Projects" />
  <section v-if="session.projects.length" class="content-grid two"><article v-for="project in session.projects" :key="project.id" class="project-card"><div class="project-head"><div><h2>{{ project.name }}</h2><p class="mono">{{ project.id }}</p></div><StatusBadge :status="project.membership_role" /></div><div class="project-scope"><strong>Scope：</strong>{{ scope(project.scope_json) }}</div><div class="retention-row"><div><span>Artifact</span><strong>{{ project.artifact_retention_days ?? 30 }} 天</strong></div><div><span>Metadata</span><strong>{{ project.metadata_retention_days ?? 180 }} 天</strong></div><div><span>Audit</span><strong>{{ project.audit_retention_days ?? 180 }} 天</strong></div></div><div class="project-actions"><RouterLink v-if="session.canAdminProject(project.id)" class="button secondary compact" :to="`/projects/${project.id}/members`"><Users :size="15" />成员</RouterLink><RouterLink v-if="session.canAdminProject(project.id)" class="button secondary compact" :to="`/projects/${project.id}/settings`"><Settings2 :size="15" />保留策略</RouterLink><RouterLink class="button ghost compact" :to="`/tasks?project_id=${encodeURIComponent(project.id)}`">查看任务</RouterLink></div></article></section>
  <EmptyState v-else title="没有可访问项目" description="请联系管理员为当前用户添加项目成员关系。" />
</template>
