import { ref } from 'vue';
import { defineStore } from 'pinia';

export type ToastTone = 'success' | 'danger' | 'info';
export interface ToastMessage { id: number; title: string; detail?: string; tone: ToastTone }

const THEME_KEY = 'cloud-scan.console.theme';

export const useUiStore = defineStore('ui', () => {
  const theme = ref<'light' | 'dark'>((localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'));
  const sidebarOpen = ref(false);
  const toasts = ref<ToastMessage[]>([]);
  let toastId = 0;

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value;
    document.documentElement.style.colorScheme = theme.value;
  }

  function toggleTheme(): void {
    theme.value = theme.value === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, theme.value);
    applyTheme();
  }

  function toast(title: string, detail = '', tone: ToastTone = 'success'): void {
    const id = ++toastId;
    toasts.value.push({ id, title, detail, tone });
    window.setTimeout(() => dismissToast(id), 5000);
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  applyTheme();
  return { theme, sidebarOpen, toasts, toggleTheme, toast, dismissToast };
});
