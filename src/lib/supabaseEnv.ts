/**
 * Production guard: browser must use same-origin /supabase proxy, not *.supabase.co.
 */

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function resolveSupabasePublicConfig(): { url: string; anonKey: string } {
  if (!rawUrl?.trim() || !anonKey?.trim()) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  }

  const url = rawUrl.trim().replace(/\/+$/, '');

  if (import.meta.env.PROD) {
    if (/\.supabase\.co\b/i.test(url)) {
      throw new Error(
        'Production build must use https://staysee.ru/supabase (Nginx proxy), not *.supabase.co. ' +
          'Create .env.production from deploy/env.vps.build.example and run npm run build.',
      );
    }
    if (!url.includes('/supabase')) {
      throw new Error(
        'Production VITE_SUPABASE_URL must end with /supabase (same-origin proxy).',
      );
    }
  }

  return { url, anonKey: anonKey.trim() };
}
