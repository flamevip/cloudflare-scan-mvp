<script setup lang="ts">import { Compass } from 'lucide-vue-next';</script>
<template><section class="error-page"><div><Compass :size="48" class="muted" /><div class="error-code">404</div><h1>页面不存在</h1><p>请求的控制台页面不存在，或者地址已经发生变化。</p><RouterLink to="/overview" class="button">返回概览</RouterLink></div></section></template>
