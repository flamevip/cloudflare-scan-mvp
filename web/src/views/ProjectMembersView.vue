<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Plus, RefreshCw, Save } from 'lucide-vue-next';
import { useRoute } from 'vue-router';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import { api } from '@/api/resources';
import type { ProjectMember, ProjectRole } from '@/api/contracts';
import { formatDate } from '@/utils/format';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

const route = useRoute(); const session = useSessionStore(); const ui = useUiStore(); const projectId = String(route.params.id);
const members = ref<ProjectMember[]>([]); const loading = ref(true); const saving = ref(''); const addOpen = ref(false); const newMember = reactive({ user_id: '', role: 'reader' as ProjectRole, status: 'active' });
const project = computed(() => session.projects.find((item) => item.id === projectId)); const isOwner = computed(() => session.hasProjectRole(projectId, 'owner'));
onMounted(load);
async function load(): Promise<void> { loading.value = true; try { members.value = (await api.members(projectId)).items; } catch (error) { ui.toast('成员加载失败', message(error), 'danger'); } finally { loading.value = false; } }
async function save(member: Pick<ProjectMember, 'user_id' | 'role' | 'status'>): Promise<void> { saving.value = member.user_id; try { await api.saveMember(projectId, member.user_id, member.role, member.status); ui.toast('成员权限已保存'); await load(); } catch (error) { ui.toast('保存失败', message(error), 'danger'); } finally { saving.value = ''; } }
async function add(): Promise<void> { if (!newMember.user_id.trim()) return; await save({ ...newMember, user_id: newMember.user_id.trim() } as ProjectMember); addOpen.value = false; newMember.user_id = ''; }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <PageHeader :title="`${project?.name || projectId} · 成员`" description="项目角色和 Token scope 同时生效；禁用成员不会删除历史审计记录。" eyebrow="Project access"><template #actions><button class="button secondary" @click="load"><RefreshCw :size="16" />刷新</button><button class="button" @click="addOpen = !addOpen"><Plus :size="16" />添加成员</button></template></PageHeader>
  <div v-if="addOpen" class="card" style="margin-bottom:16px"><form class="card-body form-grid" @submit.prevent="add"><label class="field"><span>User ID</span><input v-model="newMember.user_id" class="input" required placeholder="user_…" /></label><label class="field"><span>项目角色</span><select v-model="newMember.role" class="select"><option>reader</option><option>operator</option><option>admin</option><option v-if="isOwner">owner</option></select></label><label class="field"><span>状态</span><select v-model="newMember.status" class="select"><option>active</option><option>disabled</option></select></label><div style="display:flex;align-items:end"><button class="button"><Save :size="16" />保存成员</button></div></form></div>
  <div class="card"><LoadingSkeleton v-if="loading" :rows="7" /><div v-else-if="members.length" class="table-wrap"><table class="data-table"><thead><tr><th>用户</th><th>全局角色</th><th>项目角色</th><th>成员状态</th><th>用户状态</th><th>更新时间</th><th /></tr></thead><tbody><tr v-for="member in members" :key="member.user_id"><td><div class="table-primary"><strong>{{ member.email }}</strong><span>{{ member.user_id }}</span></div></td><td><StatusBadge :status="member.global_role" /></td><td><select v-model="member.role" class="select" :disabled="member.role === 'owner' && !isOwner"><option>reader</option><option>operator</option><option>admin</option><option v-if="isOwner">owner</option></select></td><td><select v-model="member.status" class="select"><option>active</option><option>disabled</option></select></td><td><StatusBadge :status="member.user_status" /></td><td class="muted">{{ formatDate(member.updated_at) }}</td><td><button class="button secondary compact" :disabled="saving === member.user_id" @click="save(member)"><Save :size="14" />保存</button></td></tr></tbody></table></div><EmptyState v-else title="项目暂无成员" /></div>
</template>
