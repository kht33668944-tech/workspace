const LAST_HREF_PREFIX = "workspace:last-href:";

export function readJsonStorage<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export function writeJsonStorage<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
  }
}

export function readUrlParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function replaceUrlParams(params: Record<string, string | null | undefined>): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function currentPathWithSearch(): string | null {
  if (typeof window === "undefined") return null;
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function rememberWorkspaceHref(basePath: string, href?: string): void {
  if (typeof window === "undefined") return;
  const target = href ?? currentPathWithSearch();
  if (!target) return;
  try {
    window.localStorage.setItem(`${LAST_HREF_PREFIX}${basePath}`, target);
  } catch {
    // ignore storage errors
  }
}

export function getRememberedWorkspaceHref(basePath: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(`${LAST_HREF_PREFIX}${basePath}`);
    if (!saved) return null;
    return saved === basePath || saved.startsWith(`${basePath}?`) || saved.startsWith(`${basePath}#`) ? saved : null;
  } catch {
    return null;
  }
}
