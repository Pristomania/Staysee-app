import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { PRIVACY_POLICY_META, PRIVACY_POLICY_SECTIONS } from '../../content/legal/privacy';
import { LegalDocumentView } from '../legal/LegalDocumentView';
import { ScreenBackHeader, StickyScreenLayout } from '../layout';

export function PrivacyPolicyScreen() {
  const { user } = useAuth();
  const { navigateBack } = useApp();

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title={PRIVACY_POLICY_META.title}
          subtitle={PRIVACY_POLICY_META.subtitle}
          backLabel={user ? 'Назад' : 'Назад к регистрации'}
        />
      )}
    >
      <LegalDocumentView meta={PRIVACY_POLICY_META} sections={PRIVACY_POLICY_SECTIONS} />
    </StickyScreenLayout>
  );
}
