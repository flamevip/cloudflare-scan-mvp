<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { KeyRound, Plus, RefreshCw, RotateCw, ShieldOff, X } from 'lucide-vue-next';
import PageHeader from '@/components/PageHeader.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import PaginationBar from '@/components/PaginationBar.vue';
import EmptyState from '@/components/EmptyState.vue';
import LoadingSkeleton from '@/components/LoadingSkeleton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import SecretDialog from '@/components/SecretDialog.vue';
import { api } from '@/api/resources';
import type { ApiToken } from '@/api/contracts';
import { formatDate, safeJson, shortId } from '@/utils/format';
import { useUiStore } from '@/stores/ui';

const ui = useUiStore(); const items = ref<ApiToken[]>([]); const loading = ref(true); const busy = ref(false); const createOpen = ref(false); const secret = ref(''); const secretTitle = ref('保存新的 API Token'); const page = ref(1); const pageSize = 20; const userFilter = ref(''); const confirm = reactive<{ open: boolean; action: 'rotate' | 'revoke'; token: ApiToken | null }>({ open: false, action: 'revoke', token: null });
const availableScopes = ['tasks:read', 'tasks:write', 'artifacts:read', 'search:read', 'admin:*']; const form = reactive({ user_id: '', name: '', scopes: ['tasks:read', 'tasks:write', 'artifacts:read', 'search:read'], expires_at: '' });
onMounted(load); onBeforeUnmount(clearSecret);
async function load(): Promise<void> { loading.value = true; try { items.value = (await api.tokens(page.value, pageSize, userFilter.value.trim() || undefined)).items; } catch (error) { ui.toast('Token 加载失败', message(error), 'danger'); } finally { loading.value = false; } }
async function move(value: number): Promise<void> { page.value = value; await load(); }
async function create(): Promise<void> { busy.value = true; try { const created = await api.createToken({ user_id: form.user_id.trim(), name: form.name.trim(), scopes: form.scopes, expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null }); createOpen.value = false; secretTitle.value = '保存新的 API Token'; secret.value = created.token || ''; form.name = ''; ui.toast('Token 已创建'); await load(); } catch (error) { ui.toast('创建失败', message(error), 'danger'); } finally { busy.value = false; } }
function ask(action: 'rotate' | 'revoke', token: ApiToken): void { confirm.open = true; confirm.action = action; confirm.token = token; }
async function runConfirmed(): Promise<void> { if (!confirm.token) return; busy.value = true; try { if (confirm.action === 'rotate') { const rotated = await api.rotateToken(confirm.token.id); secretTitle.value = '保存轮换后的 Token'; secret.value = rotated.token || ''; ui.toast('Token 已轮换', '旧 Token 已立即撤销。'); } else { await api.revokeToken(confirm.token.id); ui.toast('Token 已撤销'); } confirm.open = false; confirm.token = null; await load(); } catch (error) { ui.toast('操作失败', message(error), 'danger'); } finally { busy.value = false; } }
function scopes(token: ApiToken): string[] { return token.scopes || safeJson<string[]>(token.scopes_json, []); }
function clearSecret(): void { secret.value = ''; }
function message(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
</script>

<template>
  <PageHeader title="API Token" description="签发、轮换和撤销用户凭证；数据库只保存 SHA-256，明文仅返回一次。" eyebrow="Credential lifecycle"><template #actions><button class="button secondary" @click="load"><RefreshCw :size="16" />刷新</button><button class="button" @click="createOpen = true"><Plus :size="16" />创建 Token</button></template></PageHeader>
  <div class="filter-bar"><label class="field search-field"><span>按 User ID 筛选</span><input v-model="userFilter" class="input" placeholder="user_…" @keyup.enter="page = 1; load()" /></label><button class="button secondary" @click="page = 1; load()">应用</button></div>
  <div class="card"><LoadingSkeleton v-if="loading" :rows="8" /><div v-else-if="items.length" class="table-wrap"><table class="data-table"><thead><tr><th>Token</th><th>用户</th><th>Scopes</th><th>状态</th><th>到期</th><th>最后使用</th><th /></tr></thead><tbody><tr v-for="token in items" :key="token.id"><td><div class="table-primary"><strong>{{ token.name }}</strong><span>{{ token.id }}</span></div></td><td><div class="table-primary"><strong>{{ token.email || token.user_id }}</strong><span>{{ token.user_id }}</span></div></td><td><div class="checkbox-row"><span v-for="scope in scopes(token)" :key="scope" class="status-badge tone-info">{{ scope }}</span></div></td><td><StatusBadge :status="token.revoked_at ? 'revoked' : (token.expires_at && new Date(token.expires_at) < new Date() ? 'expired' : 'active')" /></td><td class="muted">{{ formatDate(token.expires_at) }}</td><td class="muted">{{ formatDate(token.last_used_at) }}</td><td><div class="table-actions"><button class="button secondary compact" :disabled="Boolean(token.revoked_at)" @click="ask('rotate', token)"><RotateCw :size="14" />轮换</button><button class="button ghost compact" :disabled="Boolean(token.revoked_at)" @click="ask('revoke', token)"><ShieldOff :size="14" />撤销</button></div></td></tr></tbody></table></div><EmptyState v-else title="没有 API Token" /><PaginationBar :page="page" :has-next="items.length === pageSize" :loading="loading" @previous="move(page - 1)" @next="move(page + 1)" /></div>
  <Teleport to="body"><div v-if="createOpen" class="modal-backdrop" @click.self="createOpen = false"><form class="modal-card" @submit.prevent="create"><button type="button" class="icon-button modal-close" @click="createOpen = false"><X :size="18" /></button><div class="dialog-icon"><KeyRound :size="21" /></div><h2>创建 API Token</h2><p>Token scope 与项目成员角色会在每次请求时共同执行。</p><div class="form-grid"><label class="field"><span>User ID</span><input v-model="form.user_id" class="input" required placeholder="user_…" /></label><label class="field"><span>名称</span><input v-model="form.name" class="input" required maxlength="100" placeholder="pilot operator" /></label><label class="field full"><span>Scopes</span><div class="checkbox-row"><label v-for="scope in availableScopes" :key="scope" class="check-card"><input v-model="form.scopes" type="checkbox" :value="scope" />{{ scope }}</label></div></label><label class="field full"><span>到期时间（可选）</span><input v-model="form.expires_at" class="input" type="datetime-local" /></label></div><div class="modal-actions"><button type="button" class="button secondary" @click="createOpen = false">取消</button><button class="button" :disabled="busy || !form.scopes.length">创建 Token</button></div></form></div></Teleport>
  <ConfirmDialog :open="confirm.open" :title="confirm.action === 'rotate' ? '轮换此 Token？' : '撤销此 Token？'" :description="confirm.action === 'rotate' ? '旧 Token 会立即撤销，新明文只显示一次。使用旧 Token 的客户端将立刻失效。' : '撤销后无法恢复，使用此凭证的 API 客户端将立即无法访问。'" :confirm-label="confirm.action === 'rotate' ? '确认轮换' : '确认撤销'" :dangerous="confirm.action === 'revoke'" :busy="busy" @close="confirm.open = false" @confirm="runConfirmed" />
  <SecretDialog :open="Boolean(secret)" :secret="secret" :title="secretTitle" @close="clearSecret" />
</template>
