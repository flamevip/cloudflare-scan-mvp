<script setup lang="ts">
import { AlertTriangle, X } from 'lucide-vue-next';
defineProps<{ open: boolean; title: string; description: string; confirmLabel?: string; dangerous?: boolean; busy?: boolean }>();
const emit = defineEmits<{ confirm: []; close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
      <section class="modal-card confirm-card" role="dialog" aria-modal="true" :aria-label="title">
        <button class="icon-button modal-close" aria-label="关闭" :disabled="busy" @click="emit('close')"><X :size="18" /></button>
        <div class="dialog-icon" :class="{ danger: dangerous }"><AlertTriangle :size="22" /></div>
        <h2>{{ title }}</h2><p>{{ description }}</p>
        <div class="modal-actions"><button class="button secondary" :disabled="busy" @click="emit('close')">返回</button><button class="button" :class="{ danger: dangerous }" :disabled="busy" @click="emit('confirm')">{{ busy ? '处理中…' : (confirmLabel || '确认') }}</button></div>
      </section>
    </div>
  </Teleport>
</template>
