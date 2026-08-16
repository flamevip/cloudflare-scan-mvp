<script setup lang="ts">import { ShieldX } from 'lucide-vue-next';</script>
<template><section class="error-page"><div><ShieldX :size="48" class="muted" /><div class="error-code">403</div><h1>权限不足</h1><p>当前用户角色或 Token scope 不允许访问此页面。系统不会自动提升权限。</p><RouterLink to="/overview" class="button">返回概览</RouterLink></div></section></template>
