import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppProvider, useApp } from './context/AppContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
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
  ConversationNotesScreen,
  PrivacyScreen,
  DisclaimerScreen,
  TermsScreen,
} from './components/screens';

const LOADING_RESET_MS = 5000;

function AppContent() {
  const { user, profile, loading, passwordRecoveryPending, emergencyResetAuth } = useAuth();
  const { currentScreen, setCurrentScreen, currentConversation } = useApp();
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
    if (passwordRecoveryPending) {
      setCurrentScreen('reset-password');
    }
  }, [passwordRecoveryPending, setCurrentScreen]);

  useEffect(() => {
    if (loading) return;

    if (passwordRecoveryPending || currentScreen === 'reset-password') return;

    if (!user) {
      const publicScreens = ['welcome', 'login', 'register', 'terms', 'privacy', 'disclaimer'];
      if (publicScreens.includes(currentScreen)) return;
      setCurrentScreen('welcome');
      return;
    }

    if (profile && profile.onboarding_completed === false) {
      if (['welcome', 'login', 'register'].includes(currentScreen)) {
        setCurrentScreen('onboarding');
        return;
      }
    }

    // After successful login, email confirm, or session restore — land on conversations list.
    if (['welcome', 'login', 'register'].includes(currentScreen)) {
      setCurrentScreen('main');
    }

    // If on chat without a loaded conversation, return to list (no auto-create).
    if (currentScreen === 'chat' && !currentConversation) {
      setCurrentScreen('main');
    }
  }, [user, profile, loading, passwordRecoveryPending, currentScreen, currentConversation, setCurrentScreen]);

  async function handleEmergencyReset() {
    await emergencyResetAuth();
    setCurrentScreen('login');
  }

  if (loading) {
    return (
      <div className={`min-h-screen ${theme.bg} flex flex-col items-center justify-center gap-6`}>
        <div className={`w-6 h-6 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
        {showLoadingReset && (
          <button
            type="button"
            onClick={() => void handleEmergencyReset()}
            className={`${theme.textMuted} text-xs font-light underline underline-offset-4 decoration-dotted opacity-70 hover:opacity-100 transition-opacity duration-200`}
          >
            Сбросить вход
          </button>
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
