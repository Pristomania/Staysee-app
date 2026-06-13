import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppProvider, useApp } from './context/AppContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { canWriteAppHistory, isAppHistoryState, replaceAppHistory } from './lib/appHistory';
import {
  WelcomeScreen,
  LoginScreen,
  ResetPasswordScreen,
  RegisterScreen,
  MainScreen,
  ChatScreen,
  ProfileScreen,
  OnboardingScreen,
  MemoryScreen,
  ConversationDynamicsScreen,
  ConversationNotesScreen,
  PrivacyScreen,
  DisclaimerScreen,
  TermsScreen,
} from './components/screens';

const LOADING_RESET_MS = 8000;

const PUBLIC_SCREENS = ['welcome', 'login', 'register', 'terms', 'privacy', 'disclaimer'] as const;
const AUTH_ENTRY_SCREENS = ['welcome', 'login', 'register'] as const;

function AppContent() {
  const { user, profile, loading, passwordRecoveryPending, emergencyResetAuth } = useAuth();
  const {
    currentScreen,
    currentConversation,
    replaceNavigation,
    applyHistoryState,
    popNavigationRef,
    seedHistory,
  } = useApp();
  const { theme } = useTheme();
  const [showLoadingReset, setShowLoadingReset] = useState(false);

  useEffect(() => {
    if (!loading) {
      setShowLoadingReset(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoadingReset(true), LOADING_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    if (!loading) seedHistory();
  }, [loading, seedHistory]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      popNavigationRef.current = true;
      try {
        let state = isAppHistoryState(event.state) ? event.state : null;
        if (state && user && AUTH_ENTRY_SCREENS.includes(state.screen as (typeof AUTH_ENTRY_SCREENS)[number])) {
          const mainState = { ...state, screen: 'main' as const, conversationId: null };
          applyHistoryState(mainState);
          if (canWriteAppHistory()) replaceAppHistory(mainState);
          return;
        }
        if (state) {
          applyHistoryState(state);
        }
      } finally {
        window.requestAnimationFrame(() => {
          popNavigationRef.current = false;
        });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [user, applyHistoryState, replaceNavigation, popNavigationRef]);

  useEffect(() => {
    if (passwordRecoveryPending) {
      replaceNavigation('reset-password');
    }
  }, [passwordRecoveryPending, replaceNavigation]);

  useEffect(() => {
    if (loading || popNavigationRef.current) return;

    if (passwordRecoveryPending || currentScreen === 'reset-password') return;

    if (!user) {
      if (PUBLIC_SCREENS.includes(currentScreen as (typeof PUBLIC_SCREENS)[number])) return;
      replaceNavigation('welcome');
      return;
    }

    if (profile && profile.onboarding_completed === false) {
      if (AUTH_ENTRY_SCREENS.includes(currentScreen as (typeof AUTH_ENTRY_SCREENS)[number])) {
        replaceNavigation('onboarding');
        return;
      }
    }

    if (AUTH_ENTRY_SCREENS.includes(currentScreen as (typeof AUTH_ENTRY_SCREENS)[number])) {
      replaceNavigation('main');
    }

    if (currentScreen === 'chat' && !currentConversation) {
      replaceNavigation('main');
    }
  }, [
    user,
    profile,
    loading,
    passwordRecoveryPending,
    currentScreen,
    currentConversation,
    replaceNavigation,
    popNavigationRef,
  ]);

  async function handleEmergencyReset() {
    await emergencyResetAuth();
    replaceNavigation('login');
  }

  if (loading) {
    return (
      <div className={`min-h-screen ${theme.bg} flex flex-col items-center justify-center gap-4 px-6 text-center`}>
        <div className={`w-6 h-6 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
        {showLoadingReset && (
          <div className="flex flex-col items-center gap-3 max-w-xs">
            <p className={`${theme.textMuted} text-sm font-light`}>
              Загрузка занимает слишком долго. Проверьте интернет или обновите страницу.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={`${theme.textMuted} text-xs font-light underline underline-offset-4 decoration-dotted opacity-70 hover:opacity-100 transition-opacity duration-200`}
              >
                Обновить
              </button>
              <button
                type="button"
                onClick={() => void handleEmergencyReset()}
                className={`${theme.textMuted} text-xs font-light underline underline-offset-4 decoration-dotted opacity-70 hover:opacity-100 transition-opacity duration-200`}
              >
                Выйти
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const renderScreen = () => {
    switch (currentScreen) {
      case 'welcome':   return <WelcomeScreen />;
      case 'login':     return <LoginScreen />;
      case 'reset-password': return <ResetPasswordScreen />;
      case 'register':    return <RegisterScreen />;
      case 'onboarding':  return user ? <OnboardingScreen /> : <WelcomeScreen />;
      case 'main':        return user ? <MainScreen /> : <WelcomeScreen />;
      case 'chat':      return user ? <ChatScreen /> : <WelcomeScreen />;
      case 'profile':   return user ? <ProfileScreen /> : <WelcomeScreen />;
      case 'memory':    return user ? <MemoryScreen /> : <WelcomeScreen />;
      case 'conversation-dynamics':
        return user ? <ConversationDynamicsScreen /> : <WelcomeScreen />;
      case 'conversation-notes':
        return user ? <ConversationNotesScreen /> : <WelcomeScreen />;
      case 'privacy':     return <PrivacyScreen />;
      case 'disclaimer':  return <DisclaimerScreen />;
      case 'terms':       return <TermsScreen />;
      default:            return <WelcomeScreen />;
    }
  };

  return renderScreen();
}

function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <ThemeProvider>
          <AppContent />
        </ThemeProvider>
      </AppProvider>
    </AuthProvider>
  );
}

export default App;
