import { useTheme } from '../../context/ThemeContext';
import type { LegalSection } from '../../content/legal/offer';
import { ACCENT_TEXT_CLASS } from '../layout';

interface LegalDocumentMeta {
  title: string;
  subtitle: string;
  version: string;
  effectiveDate: string;
}

interface LegalDocumentViewProps {
  meta: LegalDocumentMeta;
  sections: LegalSection[];
}

export function LegalDocumentView({ meta, sections }: LegalDocumentViewProps) {
  const { theme } = useTheme();

  return (
    <>
      <h2 className={`${theme.textPrimary} text-lg sm:text-xl font-light leading-[1.6] tracking-tight mb-2`}>
        {meta.title}
      </h2>
      <p className={`${theme.textMuted} text-xs font-light mb-1`}>{meta.subtitle}</p>
      <p className={`${theme.textMuted} text-[11px] font-light opacity-70 mb-8`}>
        Версия {meta.version}
        {meta.effectiveDate !== '—' ? ` · действует с ${meta.effectiveDate}` : ''}
      </p>

      <div className="space-y-6">
        {sections.map((section, i) => (
          <section key={`${section.title}-${i}`}>
            <h3 className={`${theme.textPrimary} text-sm font-light mb-2`}>
              <span className={ACCENT_TEXT_CLASS}>{section.title}</span>
            </h3>
            <p
              className={`${theme.textSecondary} text-sm font-light leading-[1.75] whitespace-pre-wrap`}
            >
              {section.body}
            </p>
          </section>
        ))}
      </div>
    </>
  );
}
