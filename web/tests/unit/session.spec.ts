import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSessionStore } from '@/stores/session';

describe('session RBAC', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('requires both project role and scope for project operations', () => {
    const store = useSessionStore();
    store.actor = {
      actor_id: 'user_1', role: 'reader', token_type: 'api_token', token_scopes: ['tasks:read', 'tasks:write'], token_expires_at: null,
      memberships: [{ project_id: 'project_a', role: 'operator' }], project_ids: ['project_a'], project_roles: { project_a: 'operator' },
    };
    expect(store.canWriteProject('project_a')).toBe(true);
    expect(store.canAdminProject('project_a')).toBe(false);
    store.actor.token_scopes.push('admin:*');
    store.actor.project_roles.project_a = 'admin';
    expect(store.canAdminProject('project_a')).toBe(true);
  });

  it('requires global admin and admin scope for system pages', () => {
    const store = useSessionStore();
    store.actor = { actor_id: 'user_1', role: 'admin', token_type: 'api_token', token_scopes: ['tasks:read'], token_expires_at: null, memberships: [], project_ids: [], project_roles: {} };
    expect(store.isGlobalAdmin).toBe(false);
    store.actor.token_scopes.push('admin:*');
    expect(store.isGlobalAdmin).toBe(true);
  });
});
