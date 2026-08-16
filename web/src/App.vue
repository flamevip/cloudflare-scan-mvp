<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from '@/components/AppShell.vue';
import ToastHost from '@/components/ToastHost.vue';

const route = useRoute();
const isLogin = computed(() => route.path === '/login');
</script>

<template>
  <RouterView v-if="isLogin" />
  <AppShell v-else>
    <RouterView />
  </AppShell>
  <ToastHost />
</template>
