import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { useSessionStore } from '@/stores/session';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    scope?: string;
    globalAdmin?: boolean;
    projectAdmin?: boolean;
    title?: string;
  }
}

const routes = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: '登录' } },
  { path: '/', redirect: '/overview' },
  { path: '/overview', component: () => import('@/views/OverviewView.vue'), meta: { requiresAuth: true, scope: 'tasks:read', title: '概览' } },
  { path: '/tasks', component: () => import('@/views/TasksView.vue'), meta: { requiresAuth: true, scope: 'tasks:read', title: '任务' } },
  { path: '/tasks/:id', component: () => import('@/views/TaskDetailView.vue'), meta: { requiresAuth: true, scope: 'tasks:read', title: '任务详情' } },
  { path: '/search', component: () => import('@/views/SearchView.vue'), meta: { requiresAuth: true, scope: 'search:read', title: 'AI Search' } },
  { path: '/projects', component: () => import('@/views/ProjectsView.vue'), meta: { requiresAuth: true, scope: 'tasks:read', title: '项目' } },
  { path: '/projects/:id/members', component: () => import('@/views/ProjectMembersView.vue'), meta: { requiresAuth: true, projectAdmin: true, title: '项目成员' } },
  { path: '/projects/:id/settings', component: () => import('@/views/ProjectSettingsView.vue'), meta: { requiresAuth: true, projectAdmin: true, title: '保留策略' } },
  { path: '/admin/users', component: () => import('@/views/AdminUsersView.vue'), meta: { requiresAuth: true, globalAdmin: true, title: '用户管理' } },
  { path: '/admin/tokens', component: () => import('@/views/AdminTokensView.vue'), meta: { requiresAuth: true, globalAdmin: true, title: 'API Token' } },
  { path: '/admin/audit', component: () => import('@/views/AdminAuditView.vue'), meta: { requiresAuth: true, globalAdmin: true, title: '审计日志' } },
  { path: '/admin/operations', component: () => import('@/views/AdminOperationsView.vue'), meta: { requiresAuth: true, globalAdmin: true, title: '运维中心' } },
  { path: '/forbidden', component: () => import('@/views/ForbiddenView.vue'), meta: { requiresAuth: true, title: '权限不足' } },
  { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFoundView.vue'), meta: { title: '页面不存在' } },
];

export const router = createRouter({ history: createWebHistory(), routes, scrollBehavior: () => ({ top: 0 }) });

router.beforeEach(async (to: RouteLocationNormalized) => {
  const session = useSessionStore();
  if (to.meta.requiresAuth && !session.authenticated) {
    const restored = await session.restore();
    if (!restored) return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.path === '/login' && session.authenticated) return '/overview';
  if (to.meta.scope && !session.hasScope(to.meta.scope)) return '/forbidden';
  if (to.meta.globalAdmin && !session.isGlobalAdmin) return '/forbidden';
  if (to.meta.projectAdmin && !session.canAdminProject(String(to.params.id ?? ''))) return '/forbidden';
  document.title = `${to.meta.title || '控制台'} · Cloud Scan`;
  return true;
});
