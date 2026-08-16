const TOKEN_KEY = 'cloud-scan.console.token';

export function getSessionToken(): string | null {
  return typeof window === 'undefined' ? null : window.sessionStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearSessionToken(): void {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(TOKEN_KEY);
}

export { TOKEN_KEY };
