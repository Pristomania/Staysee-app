import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';
import { EmergencyHelpContacts } from '../EmergencyHelpContacts';

const points = [
  {
    title: 'Не замена специалисту',
    body: 'StaySee AI — это пространство для осознанного самонаблюдения. Он не является психологом, психотерапевтом или врачом и не может заменить профессиональную помощь.',
  },
  {
    title: 'Если вам сейчас тяжело',
    body: 'Если вы переживаете острый кризис или думаете о том, чтобы причинить себе вред — пожалуйста, обратитесь к специалисту или на горячую линию психологической поддержки.',
    emergencyHelp: true,
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
    body: 'Переписка и память хранятся на серверной инфраструктуре Сервиса на территории РФ. В штатном режиме их обработка выполняется автоматически для формирования ответов и памяти. Администрация не имеет штатного интерфейса для просмотра личных разговоров. Сотрудники не читают и не анализируют переписку в штатном режиме. Мы не используем её для обучения моделей. Удаление беседы означает её безвозвратное уничтожение.',
  },
];

export function DisclaimerScreen() {
  const { navigateBack } = useApp();
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

        <div className="space-y-6 mb-8">
          {points.map(({ title, body, emergencyHelp }) => (
            <div key={title}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1.5`}>
                {title}
              </p>
              <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
                {body}
              </p>
              {emergencyHelp && <EmergencyHelpContacts
                className={`${theme.textSecondary} space-y-3 mt-3 text-[13px] font-light leading-[1.75]`}
                linkClassName={`${theme.textPrimary} underline underline-offset-4 whitespace-nowrap`}
              />}
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
