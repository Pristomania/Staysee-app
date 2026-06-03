/*
 * PrivacyScreen — Конфиденциальность и управление данными
 */

import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { Lock, Eye, Shield, Trash2, Database } from 'lucide-react';
import { ACCENT_TEXT_CLASS, ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';

const sections = [
  {
    icon: Lock,
    title: 'Что мы храним',
    body: 'Только ваши сообщения в беседах и email для входа. Мы не собираем поведенческую аналитику, не передаём данные третьим лицам и не используем ваши разговоры для обучения моделей.',
  },
  {
    icon: Eye,
    title: 'Кто имеет доступ',
    body: 'Ваши беседы защищены через Row Level Security — без вашей сессии ни одна беседа недоступна через приложение. Администрация StaySee AI не имеет штатного интерфейса для просмотра личных разговоров. На уровне базы данных сообщения хранятся в текстовом виде. Полное клиентское шифрование запланировано в следующем стабильном релизе.',
  },
  {
    icon: Shield,
    title: 'Как работает безопасность',
    body: 'Каждый запрос к данным проверяется по вашему идентификатору через Row Level Security. Без вашей сессии ни одна беседа недоступна — ни через интерфейс, ни через API.',
  },
  {
    icon: Database,
    title: 'Архитектура конфиденциальности',
    body: 'Сейчас: данные защищены RLS и доступны только вам через приложение. В планах: клиентское шифрование, при котором сервер будет видеть только зашифрованный текст. Это будет реализовано в отдельном стабильном релизе.',
  },
  {
    icon: Trash2,
    title: 'Удаление данных',
    body: 'Удалить беседу — значит удалить её навсегда. Вместе со всеми сообщениями. Без резервных копий, без возможности восстановления. Это ваш выбор, и мы его уважаем.',
  },
];

type DeleteState = 'idle' | 'confirming' | 'loading' | 'done' | 'error';

export function PrivacyScreen() {
  const { setCurrentScreen, setConversations, setMessages, setCurrentConversation, legalReturnScreen } =
    useApp();
  const { user } = useAuth();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();
  const [deleteAllState, setDeleteAllState] = useState<DeleteState>('idle');
  const [deleteMemoryState, setDeleteMemoryState] = useState<DeleteState>('idle');

  async function handleDeleteAllConversations() {
    if (!user) return;
    if (deleteAllState === 'idle') {
      setDeleteAllState('confirming');
      return;
    }
    if (deleteAllState !== 'confirming') return;
    setDeleteAllState('loading');
    try {
      const { error } = await supabase
        .from('conversations')
        .delete()
        .eq('user_id', user.id);
      if (error) throw error;
      setConversations([]);
      setMessages([]);
      setCurrentConversation(null);
      setDeleteAllState('done');
    } catch {
      setDeleteAllState('error');
    }
  }

  async function handleDeleteMemory() {
    if (!user) return;
    if (deleteMemoryState === 'idle') {
      setDeleteMemoryState('confirming');
      return;
    }
    if (deleteMemoryState !== 'confirming') return;
    setDeleteMemoryState('loading');
    try {
      const { error } = await supabase
        .from('user_memory')
        .delete()
        .eq('user_id', user.id);
      if (error) throw error;
      setDeleteMemoryState('done');
    } catch {
      setDeleteMemoryState('error');
    }
  }

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => setCurrentScreen(legalReturnScreen ?? (user ? 'profile' : 'register'))}
          title="Конфиденциальность"
          subtitle="Как мы бережём ваши данные"
          backLabel={user ? 'Назад' : 'Назад к регистрации'}
        />
      )}
    >

        <h2 className={`${theme.textPrimary} text-lg sm:text-xl font-light leading-[1.6] tracking-tight mb-6`}>
          Ваши беседы принадлежат только <span className={ACCENT_TEXT_CLASS}>вам</span>.
        </h2>

        <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5 mb-6`}>
          <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-90`}>
            Администрация StaySee AI не имеет штатного интерфейса для просмотра личных разговоров.
          </p>
        </div>

        <div className="space-y-6 mb-8">
          {sections.map(({ icon: Icon, title, body }) => (
            <div key={title} className="flex gap-3.5">
              <div className="flex-shrink-0 pt-0.5">
                <Icon className={`w-[15px] h-[15px] ${theme.textSecondary} opacity-70`} strokeWidth={1.5} />
              </div>
              <div>
                <p className={`${theme.textPrimary} text-sm font-light mb-1.5`}>
                  {title}
                </p>
                <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
                  {body}
                </p>
              </div>
            </div>
          ))}
        </div>

        <section className="mb-8">
          <p className={sectionLabel}>Управление данными</p>

          <div className="space-y-2.5">
            <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5`}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1`}>
                Удалить все беседы
              </p>
              <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-3 opacity-85`}>
                Все сообщения и беседы будут удалены навсегда. Это действие нельзя отменить.
              </p>
              {deleteAllState === 'done' ? (
                <p className={`${theme.textMuted} text-xs font-light`}>Беседы удалены.</p>
              ) : deleteAllState === 'error' ? (
                <p className="text-red-400/60 text-xs font-light">Что-то пошло не так. Попробуйте позже.</p>
              ) : deleteAllState === 'confirming' ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDeleteAllState('idle')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteAllConversations}
                    className="flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70"
                  >
                    Да, удалить всё
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleDeleteAllConversations}
                  disabled={deleteAllState === 'loading'}
                  className="py-2 px-4 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70 disabled:opacity-40"
                >
                  {deleteAllState === 'loading' ? 'Удаляю…' : 'Удалить все беседы'}
                </button>
              )}
            </div>

            <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5`}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1`}>
                Удалить память AI
              </p>
              <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-3 opacity-85`}>
                Удалит сохранённые AI-заметки о ваших предпочтениях и темах. Беседы останутся.
              </p>
              {deleteMemoryState === 'done' ? (
                <p className={`${theme.textMuted} text-xs font-light`}>Память удалена.</p>
              ) : deleteMemoryState === 'error' ? (
                <p className="text-red-400/60 text-xs font-light">Что-то пошло не так. Попробуйте позже.</p>
              ) : deleteMemoryState === 'confirming' ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDeleteMemoryState('idle')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteMemory}
                    className="flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70"
                  >
                    Да, удалить
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleDeleteMemory}
                  disabled={deleteMemoryState === 'loading'}
                  className="py-2 px-4 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70 disabled:opacity-40"
                >
                  {deleteMemoryState === 'loading' ? 'Удаляю…' : 'Удалить память AI'}
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="mb-6">
          <p className={sectionLabel}>Дисклеймер</p>
          <div className="space-y-4">
            <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
              StaySee AI — это пространство для осознанного самонаблюдения, а не замена психологической помощи.
            </p>
            <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
              Если вы переживаете острый кризис, пожалуйста, обратитесь к специалисту или на горячую линию психологической поддержки.
            </p>
            <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85`}>
              StaySee AI не ставит диагнозов, не назначает лечения и не несёт ответственности за решения, принятые на основе разговоров.
            </p>
          </div>
        </section>

        <p className={`${theme.textMuted} text-[11px] font-light opacity-40`}>
          Здесь можно побыть собой.
        </p>
    </StickyScreenLayout>
  );
}
