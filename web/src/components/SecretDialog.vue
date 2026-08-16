<script setup lang="ts">
import { Copy, KeyRound, X } from 'lucide-vue-next';
const props = defineProps<{ open: boolean; secret: string; title?: string }>();
const emit = defineEmits<{ close: [] }>();
async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.secret);
  emit('close');
}
</script>

<template>
  <Teleport to="body"><div v-if="open" class="modal-backdrop" @click.self="emit('close')"><section class="modal-card secret-card" role="dialog" aria-modal="true">
    <button class="icon-button modal-close" aria-label="关闭" @click="emit('close')"><X :size="18" /></button>
    <div class="dialog-icon"><KeyRound :size="22" /></div><h2>{{ title || '保存新的 API Token' }}</h2>
    <p>此明文只展示一次。关闭窗口后无法再次查看，请立即保存到安全的密码管理器。</p>
    <div class="secret-value"><code>{{ secret }}</code><button class="icon-button" aria-label="复制 Token（复制后关闭）" @click="copy"><Copy :size="18" /></button></div>
    <div class="modal-actions"><button class="button" @click="emit('close')">我已安全保存</button></div>
  </section></div></Teleport>
</template>
