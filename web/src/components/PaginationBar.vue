<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
defineProps<{ page: number; hasNext: boolean; loading?: boolean }>();
const emit = defineEmits<{ previous: []; next: [] }>();
</script>

<template>
  <div class="pagination-bar">
    <span>第 {{ page }} 页</span>
    <div>
      <button class="button secondary compact" :disabled="page <= 1 || loading" @click="emit('previous')"><ChevronLeft :size="16" />上一页</button>
      <button class="button secondary compact" :disabled="!hasNext || loading" @click="emit('next')">下一页<ChevronRight :size="16" /></button>
    </div>
  </div>
</template>
