<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ value: unknown; title?: string }>();
const formatted = computed(() => JSON.stringify(props.value ?? {}, null, 2));
</script>
<template><div class="json-panel"><div v-if="title" class="json-title">{{ title }}</div><pre>{{ formatted }}</pre></div></template>
