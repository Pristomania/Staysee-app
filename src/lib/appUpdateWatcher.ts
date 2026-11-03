import { isAppBusy } from './appBusy';
import {
  CHECK_EVERY_MS,
  MIN_GAP_BETWEEN_CHECKS_MS,
  decideUpdateAction,
  entryFromHtml,
  isNewVersion,
} from './appUpdate';

/**
 * The browser side of appUpdate.ts: asks the server which version is current when the person comes back to the page, when
 * the phone gets its connection back, and now and then while the page is in front of them. Calls `onNotice` when a new
 * version is there and the page was not reloaded (the person is typing, or looking at it).
 */

const RELOADED_FOR_KEY = 'staysee:update-reloaded-for';
const PRELOAD_RELOAD_KEY = 'staysee:preload-reload-at';
/** A failed build file is answered by a reload at most once in this time. */
const PRELOAD_RELOAD_GAP_MS = 60 * 1000;

function currentEntry(): string | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]');
  for (const script of Array.from(scripts)) {
    const src = script.getAttribute('src') ?? '';
    if (/^\/assets\/index-[A-Za-z0-9_-]+\.js$/.test(src)) return src;
  }
  return null;
}

async function latestEntry(): Promise<string | null> {
  try {
    // The real current page, never a kept copy.
    const response = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
    if (!response.ok) return null;
    return entryFromHtml(await response.text());
  } catch {
    return null;
  }
}

/** Something typed in a field and not sent: a reload would lose it. */
function hasUnsentText(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'textarea, input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], input[type="number"]',
  );
  return Array.from(fields).some((field) => field.value.trim() !== '');
}

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore: without it a reload could repeat, but the check itself still works
  }
}

export function startAppUpdateWatcher(onNotice: () => void): () => void {
  let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
  let lastCheckAt = 0;
  let checking = false;

  async function check(hiddenForMs: number | null): Promise<void> {
    if (checking || Date.now() - lastCheckAt < MIN_GAP_BETWEEN_CHECKS_MS) return;
    checking = true;
    lastCheckAt = Date.now();
    try {
      const current = currentEntry();
      const latest = await latestEntry();
      const action = decideUpdateAction({
        newVersion: isNewVersion(current, latest),
        hiddenForMs,
        busy: isAppBusy(),
        hasUnsentText: hasUnsentText(),
        alreadyReloadedFor: readStored(RELOADED_FOR_KEY),
        latest,
      });
      if (action === 'reload' && latest) {
        writeStored(RELOADED_FOR_KEY, latest);
        window.location.reload();
      } else if (action === 'notice') {
        onNotice();
      }
    } finally {
      checking = false;
    }
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt === null ? null : Date.now() - hiddenAt;
    hiddenAt = null;
    void check(hiddenFor);
  }
  function onOnline(): void {
    void check(null);
  }

  // A build file that is gone after an update (the page still names it) is not a blank screen: one reload brings the
  // current page. Vite names the event for its own preloads; a plain dynamic import fails as an unhandled rejection.
  function reloadOnceForMissingFile(): void {
    const last = Number(readStored(PRELOAD_RELOAD_KEY) ?? 0);
    if (Date.now() - last < PRELOAD_RELOAD_GAP_MS) return;
    writeStored(PRELOAD_RELOAD_KEY, String(Date.now()));
    window.location.reload();
  }
  function onPreloadError(event: Event): void {
    event.preventDefault();
    reloadOnceForMissingFile();
  }
  function onRejection(event: PromiseRejectionEvent): void {
    const message = String((event.reason as { message?: unknown } | null)?.message ?? event.reason ?? '');
    if (/dynamically imported module|Importing a module script failed/i.test(message)) reloadOnceForMissingFile();
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onRejection);
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void check(null);
  }, CHECK_EVERY_MS);
  // A first look soon after the page opens: a stale copy shows its age at once.
  const first = window.setTimeout(() => void check(null), 15_000);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onRejection);
    window.clearInterval(timer);
    window.clearTimeout(first);
  };
}
