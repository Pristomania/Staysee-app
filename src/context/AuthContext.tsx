import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ensureUserProfile } from '../lib/ensureProfile';
import {
  clearAuthCallbackFromUrl,
  clearPasswordRecoveryPending,
  clearRecoveryCallbackFromUrl,
  getAuthCallbackTypeFromUrl,
  hasAuthCallbackInUrl,
  markPasswordRecoveryPending,
  shouldStartInPasswordRecovery,
} from '../lib/passwordRecovery';
import { withAuthTimeout } from '../lib/authErrors';
import type { Profile } from '../types';
import type { User } from '@supabase/supabase-js';

const AUTH_LOADING_TIMEOUT_MS = 8000;

export type SignUpStatus = 'session' | 'confirm_email' | 'already_registered' | 'error';

export interface SignUpResult {
  error: Error | null;
  status: SignUpStatus;
}

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  /** User opened a password-reset link and must set a new password before using the app. */
  passwordRecoveryPending: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  completePasswordRecovery: () => void;
  /** Выйти со смены пароля без сохранения — сброс флага, URL и сессии recovery. */
  abandonPasswordRecovery: () => Promise<void>;
  /** Safety fallback when auth restore hangs — clears session and storage. */
  emergencyResetAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(
    () => shouldStartInPasswordRecovery(),
  );

  const initialRestoreDoneRef = useRef(false);

  // Must run before getSession() finishes — PASSWORD_RECOVERY is easy to miss otherwise.
  useEffect(() => {
    const callbackType = getAuthCallbackTypeFromUrl();
    if (callbackType === 'recovery') {
      markPasswordRecoveryPending();
      setPasswordRecoveryPending(true);
    } else if (callbackType) {
      // signup / magiclink / invite — not a forced password change
      clearPasswordRecoveryPending();
      setPasswordRecoveryPending(false);
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        markPasswordRecoveryPending();
        setPasswordRecoveryPending(true);
        return;
      }
      if (event === 'SIGNED_IN') {
        const urlType = getAuthCallbackTypeFromUrl();
        if (urlType !== 'recovery') {
          clearPasswordRecoveryPending();
          setPasswordRecoveryPending(false);
          if (hasAuthCallbackInUrl()) {
            clearAuthCallbackFromUrl();
          }
        }
      }
      if (event === 'SIGNED_OUT') {
        clearPasswordRecoveryPending();
        setPasswordRecoveryPending(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let authSubscription: { unsubscribe: () => void } | null = null;

    const finishLoading = () => {
      if (!cancelled) setLoading(false);
    };

    // Hard cap: loading must never stay true past 5 seconds.
    const loadingTimeoutId = window.setTimeout(finishLoading, AUTH_LOADING_TIMEOUT_MS);

    async function safeLocalSignOut() {
      try {
        await supabase.auth.signOut();
      } catch {
        // ignore
      }
    }

    async function loadProfileSafe(userId: string) {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();

        if (cancelled) return;
        if (error) throw error;
        if (data) {
          if (data.room_deletion_requested_at) {
            await safeLocalSignOut();
            if (!cancelled) {
              setUser(null);
              setProfile(null);
            }
            return;
          }
          setProfile(data);
          return;
        }
        const { data: { user: authUser } } = await supabase.auth.getUser();
        const ensured = await ensureUserProfile(userId, authUser?.email ?? null);
        if (cancelled) return;
        if (!ensured.ok) {
          setProfile(null);
          return;
        }
        const { data: refetched } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .maybeSingle();
        if (!cancelled) setProfile(refetched);
      } catch {
        if (!cancelled) setProfile(null);
      }
    }

    function subscribeToAuthChanges() {
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
        // Only handle auth updates after the initial getSession() restore finished.
        if (cancelled || !initialRestoreDoneRef.current) return;

        const nextUser = session?.user ?? null;
        setUser(nextUser);

        if (!nextUser) {
          setProfile(null);
          return;
        }

        // Defer Supabase calls — awaiting inside this callback can deadlock auth restore.
        window.setTimeout(() => {
          if (!cancelled) void loadProfileSafe(nextUser.id);
        }, 0);
      });

      authSubscription = subscription;
    }

    async function restoreSession() {
      setLoading(true);

      try {
        const { data, error } = await supabase.auth.getSession();
        if (cancelled) return;

        if (error) {
          await safeLocalSignOut();
          setUser(null);
          setProfile(null);
          return;
        }

        const session = data.session;
        if (!session?.user) {
          setUser(null);
          setProfile(null);
          return;
        }

        const expiresAt = session.expires_at;
        if (expiresAt && expiresAt * 1000 < Date.now()) {
          await safeLocalSignOut();
          setUser(null);
          setProfile(null);
          return;
        }

        setUser(session.user);
        // Profile loads in background — must not block render.
        void loadProfileSafe(session.user.id);
      } catch {
        await safeLocalSignOut();
        if (cancelled) return;
        setUser(null);
        setProfile(null);
      } finally {
        if (!cancelled) {
          initialRestoreDoneRef.current = true;
          finishLoading();
          subscribeToAuthChanges();
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
      window.clearTimeout(loadingTimeoutId);
      authSubscription?.unsubscribe();
    };
  }, []);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error };

    const { data: { user: signedIn } } = await supabase.auth.getUser();
    if (signedIn) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('room_deletion_requested_at')
        .eq('id', signedIn.id)
        .maybeSingle();
      if (prof?.room_deletion_requested_at) {
        await supabase.auth.signOut();
        setUser(null);
        setProfile(null);
        return { error: new Error('room_deleted') };
      }
    }

    clearPasswordRecoveryPending();
    clearRecoveryCallbackFromUrl();
    setPasswordRecoveryPending(false);
    return { error: null };
  }

  async function signUp(email: string, password: string): Promise<SignUpResult> {
    try {
      const { data, error } = await withAuthTimeout(
        supabase.auth.signUp({ email: email.trim(), password }),
      );
      if (error) {
        return { error, status: 'error' };
      }

      // Supabase returns success without identities when email already exists (anti-enumeration).
      const identityCount = data.user?.identities?.length ?? 0;
      if (data.user && identityCount === 0) {
        return { error: null, status: 'already_registered' };
      }

      if (data.session) {
        return { error: null, status: 'session' };
      }

      return { error: null, status: 'confirm_email' };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { error, status: 'error' };
    }
  }

  async function signOut() {
    clearPasswordRecoveryPending();
    setPasswordRecoveryPending(false);
    await supabase.auth.signOut();
  }

  function completePasswordRecovery() {
    clearPasswordRecoveryPending();
    clearRecoveryCallbackFromUrl();
    setPasswordRecoveryPending(false);
  }

  async function abandonPasswordRecovery() {
    clearPasswordRecoveryPending();
    clearRecoveryCallbackFromUrl();
    setPasswordRecoveryPending(false);
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
    setUser(null);
    setProfile(null);
  }

  async function refreshProfile() {
    if (!user) return;
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (data) setProfile(data);
  }

  async function emergencyResetAuth() {
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }
    clearPasswordRecoveryPending();
    setPasswordRecoveryPending(false);
    setUser(null);
    setProfile(null);
    setLoading(false);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        passwordRecoveryPending,
        signIn,
        signUp,
        signOut,
        refreshProfile,
        completePasswordRecovery,
        abandonPasswordRecovery,
        emergencyResetAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
