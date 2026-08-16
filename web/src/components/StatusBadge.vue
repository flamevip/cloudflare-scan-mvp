<script setup lang="ts">
import { computed } from 'vue';
import { statusTone } from '@/utils/format';
const props = defineProps<{ status?: string | null; label?: string }>();
const tone = computed(() => statusTone(props.status));
</script>

<template><span class="status-badge" :class="`tone-${tone}`"><i />{{ label || status || 'unknown' }}</span></template>
