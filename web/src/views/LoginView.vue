<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Eye, EyeOff, KeyRound, LockKeyhole, ShieldCheck } from 'lucide-vue-next';
import { api } from '@/api/resources';
import { ApiError } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import type { Health } from '@/api/contracts';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const token = ref('');
const visible = ref(false);
const loading = ref(false);
const error = ref('');
const requestId = ref<string | null>(null);
const health = ref<Health | null>(null);

onMounted(async () => {
  try { health.value = await api.health(); } catch { health.value = null; }
});

async function submit(): Promise<void> {
  loading.value = true; error.value = ''; requestId.value = null;
  try {
    await session.login(token.value);
    token.value = '';
    await router.replace(typeof route.query.redirect === 'string' ? route.query.redirect : '/overview');
  } catch (caught) {
    const apiError = caught instanceof ApiError ? caught : null;
    error.value = apiError?.backendMessage || (caught instanceof Error ? caught.message : 'Token 验证失败');
    requestId.value = apiError?.requestId ?? null;
  } finally { loading.value = false; }
}
</script>

<template>
  <div class="auth-page">
    <section class="auth-visual">
      <div class="auth-brand"><div class="brand-mark"><ShieldCheck :size="22" /></div><span>Cloud Scan</span></div>
      <div class="auth-copy"><span>Security operations workspace</span><h1>让每一次扫描<br />清晰可控。</h1><p>统一管理扫描任务、云端 Agent、资产、发现项和审计记录，面向安全团队的轻量生产控制台。</p></div>
      <div class="auth-runtime"><span class="status-dot" /><span v-if="health">{{ health.service }} · {{ health.env }} · 服务可用</span><span v-else>正在检查服务状态</span></div>
    </section>
    <section class="auth-panel">
      <form class="auth-form" @submit.prevent="submit">
        <span class="eyebrow">Console access</span><h2>登录管理台</h2><p>使用管理员签发的 API Token 解锁当前会话。</p>
        <div v-if="error" class="callout danger"><LockKeyhole :size="18" /><div><strong>无法验证凭证</strong>{{ error }}<span v-if="requestId"><br />Request ID：{{ requestId }}</span></div></div>
        <label class="field" style="margin-top: 18px"><span>Bearer Token</span><div style="position:relative"><input v-model="token" class="input" :type="visible ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="scan_… 或 dev-token" style="padding-right: 44px" /><button type="button" class="icon-button" style="position:absolute;right:2px;top:2px" :aria-label="visible ? '隐藏 Token' : '显示 Token'" @click="visible = !visible"><EyeOff v-if="visible" :size="18" /><Eye v-else :size="18" /></button></div></label>
        <button class="button" type="submit" :disabled="loading || !token.trim()"><KeyRound :size="17" />{{ loading ? '正在验证…' : '验证并进入' }}</button>
        <div class="auth-note"><ShieldCheck :size="17" /><span>Token 仅保存在当前标签页的 sessionStorage 中；关闭标签页后自动清除，不会写入 URL 或持久存储。</span></div>
      </form>
    </section>
  </div>
</template>
