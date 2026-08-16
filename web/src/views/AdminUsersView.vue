<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Plus, Search, X } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import { api } from '@/api/resources';
import type { User } from '@/api/contracts';
import { formatDate } from '@/utils/format';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore(); const items = ref<User[]>([]); const loading = ref(true); const creating = ref(false); const open = ref(false); const page = ref(1); const pageSize = 20; const q = ref(''); const form = reactive({ email: '', role: 'reader', status: 'active' });
onMounted(load);
async function load(): Promise<void> { loading.value = true; try { items.value = (await api.users(page.value, pageSize, q.value.trim() || undefined)).items; } catch (error) { ui.toast('用户加载失败', message(error), 'danger'); } finally { loading.value = false; } }
async function search(): Promise<void> { page.value = 1; await load(); }
async function move(value: number): Promise<void> { page.value = value; await load(); }
async function create(): Promise<void> { creating.value = true; try { await api.createUser({ ...form }); open.value = false; form.email = ''; ui.toast('用户已创建', '请继续为用户添加项目成员关系并签发 Token。'); await load(); } catch (error) { ui.toast('创建失败', message(error), 'danger'); } finally { creating.value = false; } }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <PageHeader title="用户管理" description="管理全局身份元数据；当前接口支持创建与查询，不提供密码或登录会话。" eyebrow="Global administration"><template #actions><button class="button" @click="open = true"><Plus :size="16" />创建用户</button></template></PageHeader>
  <form class="filter-bar" @submit.prevent="search"><label class="field search-field"><span>搜索邮箱</span><input v-model="q" class="input" placeholder="operator@example.com" /></label><button class="button secondary"><Search :size="16" />查询</button></form>
  <div class="card"><LoadingSkeleton v-if="loading" :rows="7" /><div v-else-if="items.length" class="table-wrap"><table class="data-table"><thead><tr><th>用户</th><th>全局角色</th><th>状态</th><th>创建时间</th><th>更新时间</th></tr></thead><tbody><tr v-for="user in items" :key="user.id"><td><div class="table-primary"><strong>{{ user.email }}</strong><span>{{ user.id }}</span></div></td><td><StatusBadge :status="user.role" /></td><td><StatusBadge :status="user.status" /></td><td class="muted">{{ formatDate(user.created_at) }}</td><td class="muted">{{ formatDate(user.updated_at) }}</td></tr></tbody></table></div><EmptyState v-else title="没有匹配用户" /><PaginationBar :page="page" :has-next="items.length === pageSize" :loading="loading" @previous="move(page - 1)" @next="move(page + 1)" /></div>
  <Teleport to="body"><div v-if="open" class="modal-backdrop" @click.self="open = false"><form class="modal-card" @submit.prevent="create"><button type="button" class="icon-button modal-close" @click="open = false"><X :size="18" /></button><span class="eyebrow">New identity</span><h2>创建用户</h2><p>用户创建后不会自动获得任何项目权限，也不会自动生成 Token。</p><div class="form-grid"><label class="field full"><span>邮箱</span><input v-model="form.email" class="input" type="email" maxlength="254" required /></label><label class="field"><span>全局角色</span><select v-model="form.role" class="select"><option value="reader">reader</option><option value="admin">admin</option></select></label><label class="field"><span>状态</span><select v-model="form.status" class="select"><option value="active">active</option><option value="disabled">disabled</option></select></label></div><div class="modal-actions"><button type="button" class="button secondary" @click="open = false">取消</button><button class="button" :disabled="creating">{{ creating ? '创建中…' : '创建用户' }}</button></div></form></div></Teleport>
</template>
