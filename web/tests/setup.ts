import { afterEach, beforeEach, vi } from 'vitest';

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  document.body.innerHTML = '';
});
