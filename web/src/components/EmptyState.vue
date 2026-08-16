<script setup lang="ts">
import { Inbox } from 'lucide-vue-next';
defineProps<{ title?: string; description?: string }>();
</script>

<template><div class="empty-state"><div><Inbox :size="24" /></div><strong>{{ title || '暂无数据' }}</strong><span>{{ description || '当前筛选条件下没有可显示的记录。' }}</span><slot /></div></template>
