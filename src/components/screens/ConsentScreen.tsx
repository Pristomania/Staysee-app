import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { CONSENT_META, CONSENT_SECTIONS } from '../../content/legal/consent';
import { LegalDocumentView } from '../legal/LegalDocumentView';
import { ScreenBackHeader, StickyScreenLayout } from '../layout';

export function ConsentScreen() {
  const { user } = useAuth();
  const { navigateBack } = useApp();

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title={CONSENT_META.title}
          subtitle={CONSENT_META.subtitle}
          backLabel={user ? 'Назад' : 'Назад к регистрации'}
        />
      )}
    >
      <LegalDocumentView meta={CONSENT_META} sections={CONSENT_SECTIONS} />
    </StickyScreenLayout>
  );
}
