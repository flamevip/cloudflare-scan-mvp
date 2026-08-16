import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { api } from '@/api/resources';
import { clearSessionToken, getSessionToken, setSessionToken } from '@/api/token';
import type { AuthContext, Health, Project, ProjectRole } from '@/api/contracts';

const ROLE_RANK: Record<ProjectRole, number> = { reader: 1, operator: 2, admin: 3, owner: 4 };

export const useSessionStore = defineStore('session', () => {
  const actor = ref<AuthContext | null>(null);
  const health = ref<Health | null>(null);
  const projects = ref<Project[]>([]);
  const restoring = ref(false);

  const authenticated = computed(() => Boolean(actor.value && getSessionToken()));
  const isPilot = computed(() => health.value?.env === 'pilot');
  const displayName = computed(() => actor.value?.actor_email || actor.value?.actor_id || '未登录');
  const isGlobalAdmin = computed(() => actor.value?.role === 'admin' && hasScope('admin:*'));

  function hasScope(required: string): boolean {
    const scopes = new Set(actor.value?.token_scopes ?? []);
    if (!actor.value) return false;
    if (actor.value.token_type === 'dev_admin' || scopes.has('*')) return true;
    if (required.startsWith('admin:') && scopes.has('admin:*')) return true;
    if (scopes.has(required)) return true;
    return required === 'tasks:read' && scopes.has('tasks:write');
  }

  function hasProjectRole(projectId: string, minimum: ProjectRole): boolean {
    const role = actor.value?.project_roles[projectId];
    return Boolean(role && ROLE_RANK[role] >= ROLE_RANK[minimum]);
  }

  function canWriteProject(projectId: string): boolean {
    return hasScope('tasks:write') && hasProjectRole(projectId, 'operator');
  }

  function canAdminProject(projectId: string): boolean {
    return hasScope('admin:*') && hasProjectRole(projectId, 'admin');
  }

  async function login(token: string): Promise<void> {
    const normalized = token.trim().replace(/^Bearer\s+/i, '');
    if (!normalized) throw new Error('请输入有效的 Bearer Token');
    setSessionToken(normalized);
    try {
      const [me, runtime] = await Promise.all([api.me(), api.health()]);
      actor.value = me;
      health.value = runtime;
      await loadProjects();
    } catch (error) {
      clear();
      throw error;
    }
  }

  async function restore(): Promise<boolean> {
    if (!getSessionToken()) return false;
    restoring.value = true;
    try {
      const [me, runtime] = await Promise.all([api.me(), api.health()]);
      actor.value = me;
      health.value = runtime;
      await loadProjects();
      return true;
    } catch {
      clear();
      return false;
    } finally {
      restoring.value = false;
    }
  }

  async function loadProjects(): Promise<void> {
    if (!hasScope('tasks:read')) { projects.value = []; return; }
    projects.value = (await api.projects()).items;
  }

  function clear(): void {
    clearSessionToken();
    actor.value = null;
    health.value = null;
    projects.value = [];
  }

  return {
    actor, health, projects, restoring, authenticated, isPilot, displayName, isGlobalAdmin,
    hasScope, hasProjectRole, canWriteProject, canAdminProject, login, restore, loadProjects, clear,
  };
});
