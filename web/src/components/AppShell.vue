<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Activity, Blocks, ChevronRight, CircleUserRound, FileSearch, KeyRound, LayoutDashboard,
  LogOut, Menu, Moon, ScanSearch, Search, ShieldCheck, Sun, Users, X,
} from 'lucide-vue-next';
import { useSessionStore } from '@/stores/session';
import { useUiStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const ui = useUiStore();

const primary = computed(() => [
  { to: '/overview', label: '概览', icon: LayoutDashboard, show: session.hasScope('tasks:read') },
  { to: '/tasks', label: '扫描任务', icon: ScanSearch, show: session.hasScope('tasks:read') },
  { to: '/search', label: 'AI Search', icon: Search, show: session.hasScope('search:read') },
  { to: '/projects', label: '项目', icon: Blocks, show: session.hasScope('tasks:read') },
].filter((item) => item.show));

const admin = computed(() => [
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/tokens', label: 'API Token', icon: KeyRound },
  { to: '/admin/audit', label: '审计日志', icon: FileSearch },
  { to: '/admin/operations', label: '运维中心', icon: Activity },
]);

function active(path: string): boolean {
  return route.path === path || (path !== '/overview' && route.path.startsWith(`${path}/`));
}

function closeSidebar(): void { ui.sidebarOpen = false; }
function logout(): void { session.clear(); void router.replace('/login'); }
</script>

<template>
  <div class="app-frame">
    <div v-if="ui.sidebarOpen" class="sidebar-scrim" @click="closeSidebar" />
    <aside class="sidebar" :class="{ open: ui.sidebarOpen }">
      <div class="brand-row">
        <div class="brand-mark"><ShieldCheck :size="22" /></div>
        <div><strong>Cloud Scan</strong><span>Security Console</span></div>
        <button class="icon-button close-sidebar" aria-label="关闭导航" @click="closeSidebar"><X :size="20" /></button>
      </div>

      <nav class="nav-groups" aria-label="主导航">
        <div class="nav-group">
          <span class="nav-label">工作区</span>
          <RouterLink v-for="item in primary" :key="item.to" :to="item.to" class="nav-link" :class="{ active: active(item.to) }" @click="closeSidebar">
            <component :is="item.icon" :size="18" /><span>{{ item.label }}</span><ChevronRight class="nav-arrow" :size="15" />
          </RouterLink>
        </div>
        <div v-if="session.isGlobalAdmin" class="nav-group">
          <span class="nav-label">系统管理</span>
          <RouterLink v-for="item in admin" :key="item.to" :to="item.to" class="nav-link" :class="{ active: active(item.to) }" @click="closeSidebar">
            <component :is="item.icon" :size="18" /><span>{{ item.label }}</span><ChevronRight class="nav-arrow" :size="15" />
          </RouterLink>
        </div>
      </nav>

      <div class="sidebar-footer">
        <div class="environment-card">
          <span class="status-dot" :class="session.health?.env" />
          <div><small>当前环境</small><strong>{{ session.health?.env || 'unknown' }}</strong></div>
          <span class="environment-badge">{{ session.health?.service === 'scan-mvp-api' ? '在线' : '检查中' }}</span>
        </div>
      </div>
    </aside>

    <section class="app-content">
      <header class="topbar">
        <button class="icon-button mobile-menu" aria-label="打开导航" @click="ui.sidebarOpen = true"><Menu :size="21" /></button>
        <div class="topbar-context">
          <span>{{ route.meta.title }}</span>
          <small>{{ session.projects.length }} 个可访问项目</small>
        </div>
        <div class="topbar-actions">
          <button class="icon-button" :aria-label="ui.theme === 'light' ? '切换深色模式' : '切换浅色模式'" @click="ui.toggleTheme">
            <Moon v-if="ui.theme === 'light'" :size="19" /><Sun v-else :size="19" />
          </button>
          <div class="user-chip">
            <CircleUserRound :size="20" />
            <div><strong>{{ session.displayName }}</strong><span>{{ session.actor?.role }} · {{ session.actor?.token_type }}</span></div>
          </div>
          <button class="icon-button" aria-label="退出登录" title="退出登录" @click="logout"><LogOut :size="19" /></button>
        </div>
      </header>
      <main class="page-container"><slot /></main>
    </section>
  </div>
</template>
