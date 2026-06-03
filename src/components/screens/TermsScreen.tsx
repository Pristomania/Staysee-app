import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { OFFER_META, OFFER_SECTIONS } from '../../content/legal/offer';
import { LegalDocumentView } from '../legal/LegalDocumentView';
import { ScreenBackHeader, StickyScreenLayout } from '../layout';

export function TermsScreen() {
  const { user } = useAuth();
  const { setCurrentScreen, legalReturnScreen } = useApp();

  const backTarget = legalReturnScreen ?? (user ? 'profile' : 'register');

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => setCurrentScreen(backTarget)}
          title={OFFER_META.title}
          subtitle={OFFER_META.subtitle}
          backLabel={user ? 'Назад' : 'Назад к регистрации'}
        />
      )}
    >
      <LegalDocumentView meta={OFFER_META} sections={OFFER_SECTIONS} />
    </StickyScreenLayout>
  );
}
