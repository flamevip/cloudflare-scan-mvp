<script setup lang="ts">
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-vue-next';
import { useUiStore } from '@/stores/ui';
const ui = useUiStore();
</script>

<template><Teleport to="body"><div class="toast-stack" aria-live="polite"><div v-for="toast in ui.toasts" :key="toast.id" class="toast" :class="toast.tone">
  <CheckCircle2 v-if="toast.tone === 'success'" :size="20" /><AlertCircle v-else-if="toast.tone === 'danger'" :size="20" /><Info v-else :size="20" />
  <div><strong>{{ toast.title }}</strong><span v-if="toast.detail">{{ toast.detail }}</span></div><button class="icon-button" aria-label="关闭通知" @click="ui.dismissToast(toast.id)"><X :size="16" /></button>
</div></div></Teleport></template>
