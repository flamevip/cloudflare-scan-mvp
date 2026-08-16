import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import { useSessionStore } from './stores/session';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);

window.addEventListener('cloud-scan:unauthorized', () => {
  useSessionStore().clear();
  if (router.currentRoute.value.path !== '/login') void router.replace('/login');
});

app.mount('#app');
