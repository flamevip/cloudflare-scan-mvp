<script setup lang="ts">defineProps<{ rows?: number }>();</script>
<template><div class="skeleton-stack" aria-label="加载中"><span v-for="item in (rows || 4)" :key="item" class="skeleton-line" :style="{ width: `${100 - item * 6}%` }" /></div></template>
