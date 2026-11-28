/** Public application documents live on the storefront, not on the app or waitlist privacy page. */
import { OFFER_META } from '../content/legal/offer';
import { PRIVACY_POLICY_META } from '../content/legal/privacy';
import { CONSENT_META } from '../content/legal/consent';
export const PUBLIC_SITE_URL = 'https://stayseeai.online';
export const APP_URL = 'https://app.stayseeai.online';
export const PUBLIC_LEGAL_LINKS = {
  terms: {path: '/offer.html', label: 'Оферта приложения'},
  policy: {path: '/app-privacy.html', label: 'Политика данных приложения'},
  consent: {path: '/consent.html', label: 'Согласие на обработку данных'},
  pricing: {path: '/pricing.html', label: 'Тарифы'},
  contacts: {path: '/contacts.html', label: 'Контакты и реквизиты'},
} as const;

export const PUBLIC_DOCUMENT_META = {terms: OFFER_META, policy: PRIVACY_POLICY_META, consent: CONSENT_META};
