import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { ACCENT_TEXT_CLASS, ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';

const points = [
  {
    title: 'Не замена специалисту',
    body: 'StaySee AI — это пространство для осознанного самонаблюдения. Он не является психологом, психотерапевтом или врачом и не может заменить профессиональную помощь.',
  },
  {
    title: 'Если вам сейчас тяжело',
    body: 'Если вы переживаете острый кризис или думаете о том, чтобы причинить себе вред — пожалуйста, обратитесь к специалисту или на горячую линию психологической поддержки.',
  },
  {
    title: 'Без диагнозов и назначений',
    body: 'StaySee AI не ставит диагнозов, не назначает лечения и не даёт медицинских рекомендаций. Все ответы носят исключительно поддерживающий и рефлексивный характер.',
  },
  {
    title: 'Ответственность',
    body: 'Решения, принятые на основе разговоров с StaySee AI, остаются вашей ответственностью. Мы не несём ответственности за последствия этих решений.',
  },
  {
    title: 'Конфиденциальность',
    body: 'Ваши беседы хранятся только у вас. Мы не читаем их, не анализируем и не используем для обучения. Удаление беседы означает её безвозвратное уничтожение.',
  },
];

export function DisclaimerScreen() {
  const { user } = useAuth();
  const { navigateBack, legalReturnScreen } = useApp();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
          title="Дисклеймер"
          subtitle="Важная информация об использовании"
          backLabel="Назад"
        />
      )}
    >

        <h2 className={`${theme.textPrimary} text-lg sm:text-xl font-light leading-[1.6] tracking-tight mb-8`}>
          Ваши разговоры принадлежат только <span className={ACCENT_TEXT_CLASS}>вам</span>.
        </h2>

        <div className="space-y-6 mb-8">
          {points.map(({ title, body }) => (
            <div key={title}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1.5`}>
                {title}
              </p>
              <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
                {body}
              </p>
            </div>
          ))}
        </div>

        <p className={sectionLabel}>О сервисе</p>
        <p className={`${theme.textMuted} text-[11px] font-light opacity-40`}>
          StaySee AI · 2025
        </p>
    </StickyScreenLayout>
  );
}
