/*
 * PrivacyScreen — Конфиденциальность и управление данными
 */

import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { deleteAllMemoryV3Data } from '../../lib/memoryV3Viewer';
import { isLegacyMemoryCompatibilityEnabled } from '../../lib/memoryScreenMode';
import {
  browserVoiceModelCacheDeps,
  deleteVoiceModelPackage,
  isVoiceModelCached,
} from '../../lib/voiceModelCache';
import {
  browserVoiceConsentStorage,
  forgetVoiceDownloadConsent,
} from '../../lib/voiceDownloadConsent';
import {
  VOICE_ENGINE_CREDITS,
  VOICE_ENGINE_LICENCE_NOTE,
  VOICE_ENGINE_NOTICE_BODY,
  VOICE_ENGINE_NOTICE_TITLE,
} from '../../content/legal/voiceEngineNotice';
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

function DeleteAction({
  title,
  description,
  doneText,
  state,
  onStart,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  doneText: string;
  state: DeleteState;
  onStart: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { theme } = useTheme();
  return (
    <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5`}>
      <p className={`${theme.textPrimary} text-sm font-light mb-1`}>{title}</p>
      <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-3 opacity-85`}>
        {description}
      </p>
      {state === 'done' ? (
        <p className={`${theme.textMuted} text-xs font-light`}>{doneText}</p>
      ) : state === 'error' ? (
        <p className="text-red-400/60 text-xs font-light">Что-то пошло не так. Попробуйте позже.</p>
      ) : state === 'confirming' ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={`flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70"
          >
            Да, удалить
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onStart}
          disabled={state === 'loading'}
          className="py-2 px-4 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70 disabled:opacity-40"
        >
          {state === 'loading' ? 'Удаляю…' : 'Удалить'}
        </button>
      )}
    </div>
  );
}

export function PrivacyScreen() {
  const { navigateBack, setConversations, setMessages, setCurrentConversation } =
    useApp();
  const { user, profile } = useAuth();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();
  const showLegacyMemoryDelete = isLegacyMemoryCompatibilityEnabled(profile);
  const [deleteAllState, setDeleteAllState] = useState<DeleteState>('idle');
  const [deleteMemoryState, setDeleteMemoryState] = useState<DeleteState>('idle');
  const [deleteLifecycleState, setDeleteLifecycleState] = useState<DeleteState>('idle');
  const [deleteDialogueState, setDeleteDialogueState] = useState<DeleteState>('idle');
  const [deleteMemoryV3State, setDeleteMemoryV3State] = useState<DeleteState>('idle');

  /** `null` until the Cache Storage probe answers. */
  const [voicePackagePresent, setVoicePackagePresent] = useState<boolean | null>(null);
  const [deleteVoiceState, setDeleteVoiceState] = useState<DeleteState>('idle');

  useEffect(() => {
    let cancelled = false;
    void isVoiceModelCached(browserVoiceModelCacheDeps()).then((cached) => {
      if (!cancelled) setVoicePackagePresent(cached);
    });
    return () => { cancelled = true; };
  }, []);

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

  async function handleDeleteLifecycle() {
    if (!user) return;
    if (deleteLifecycleState === 'idle') {
      setDeleteLifecycleState('confirming');
      return;
    }
    if (deleteLifecycleState !== 'confirming') return;
    setDeleteLifecycleState('loading');
    try {
      const { error } = await deleteAllMemoryV3Data('account_wide');
      if (error) throw new Error('delete_lifecycle_failed');
      setDeleteLifecycleState('done');
    } catch {
      setDeleteLifecycleState('error');
    }
  }

  async function handleDeleteDialogue() {
    if (!user) return;
    if (deleteDialogueState === 'idle') {
      setDeleteDialogueState('confirming');
      return;
    }
    if (deleteDialogueState !== 'confirming') return;
    setDeleteDialogueState('loading');
    try {
      const { error } = await deleteAllMemoryV3Data('dialogue');
      if (error) throw new Error('delete_dialogue_failed');
      setDeleteDialogueState('done');
    } catch {
      setDeleteDialogueState('error');
    }
  }

  async function handleDeleteMemoryV3() {
    if (!user) return;
    if (deleteMemoryV3State === 'idle') {
      setDeleteMemoryV3State('confirming');
      return;
    }
    if (deleteMemoryV3State !== 'confirming') return;
    setDeleteMemoryV3State('loading');
    try {
      const [lifecycleResult, dialogueResult] = await Promise.all([
        deleteAllMemoryV3Data('account_wide'),
        deleteAllMemoryV3Data('dialogue'),
      ]);
      if (lifecycleResult.error || dialogueResult.error) throw new Error('delete_all_failed');
      setDeleteMemoryV3State('done');
    } catch {
      setDeleteMemoryV3State('error');
    }
  }

  async function handleDeleteVoicePackage() {
    // Deliberately no `if (!user) return;`, unlike every handler above: the
    // voice package is data in this browser, not data in an account, and
    // this screen is reachable without being signed in.
    if (deleteVoiceState === 'idle') {
      setDeleteVoiceState('confirming');
      return;
    }
    if (deleteVoiceState !== 'confirming') return;
    setDeleteVoiceState('loading');
    try {
      // Removes exactly one named cache and enumerates nothing, so the
      // account, the conversations, the memory and every other site cache
      // are untouched. A `false` return means there was nothing to remove
      // (no Cache Storage in this context) -- not a failure.
      await deleteVoiceModelPackage(browserVoiceModelCacheDeps());
      // Deleting the package withdraws the agreement to download it.
      // Without this, the next press of the microphone would start an 83 MB
      // download with no question asked.
      forgetVoiceDownloadConsent(browserVoiceConsentStorage());
      setVoicePackagePresent(false);
      setDeleteVoiceState('done');
    } catch {
      setDeleteVoiceState('error');
    }
  }

  return (
    <StickyScreenLayout
      header={(
        <ScreenBackHeader
          pinned
          onBack={() => navigateBack()}
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
            <DeleteAction
              title="Удалить все беседы"
              description="Все сообщения и беседы будут удалены навсегда. Это действие нельзя отменить."
              doneText="Беседы удалены."
              state={deleteAllState}
              onStart={handleDeleteAllConversations}
              onCancel={() => setDeleteAllState('idle')}
              onConfirm={handleDeleteAllConversations}
            />

            {showLegacyMemoryDelete && (
              <DeleteAction
                title="Удалить старую память"
                description="Удалит сохранённые AI-заметки о ваших предпочтениях и темах. Беседы останутся."
                doneText="Память удалена."
                state={deleteMemoryState}
                onStart={handleDeleteMemory}
                onCancel={() => setDeleteMemoryState('idle')}
                onConfirm={handleDeleteMemory}
              />
            )}

            <DeleteAction
              title="Удалить сквозную память"
              description="Удалит устойчивые факты профиля, накопленные из всех бесед. Сами беседы останутся."
              doneText="Сквозная память удалена."
              state={deleteLifecycleState}
              onStart={handleDeleteLifecycle}
              onCancel={() => setDeleteLifecycleState('idle')}
              onConfirm={handleDeleteLifecycle}
            />

            <DeleteAction
              title="Удалить память бесед"
              description="Удалит устойчивые факты, накопленные внутри отдельных бесед. Сами беседы останутся."
              doneText="Память бесед удалена."
              state={deleteDialogueState}
              onStart={handleDeleteDialogue}
              onCancel={() => setDeleteDialogueState('idle')}
              onConfirm={handleDeleteDialogue}
            />

            <DeleteAction
              title="Удалить всю память"
              description="Удалит и сквозную память, и память бесед одновременно. Сами беседы останутся."
              doneText="Вся память удалена."
              state={deleteMemoryV3State}
              onStart={handleDeleteMemoryV3}
              onCancel={() => setDeleteMemoryV3State('idle')}
              onConfirm={handleDeleteMemoryV3}
            />
          </div>
        </section>

        <section className="mb-8">
          <p className={sectionLabel}>Голосовой ввод</p>

          <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5 mb-2.5`}>
            <p className={`${theme.textPrimary} text-sm font-light mb-1.5`}>
              {VOICE_ENGINE_NOTICE_TITLE}
            </p>
            <p className={`${theme.textSecondary} text-[13px] font-light leading-[1.75] opacity-85 mb-3`}>
              {VOICE_ENGINE_NOTICE_BODY}
            </p>

            <div className="space-y-2.5">
              {VOICE_ENGINE_CREDITS.map((credit) => (
                <div key={credit.title}>
                  <p className={`${theme.textSecondary} text-xs font-light`}>{credit.title}</p>
                  <p className={`${theme.textMuted} text-xs font-light leading-relaxed`}>
                    {`${credit.detail} · ${credit.licence}`}
                  </p>
                  <a
                    href={credit.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={`${ACCENT_TEXT_CLASS} text-xs font-light underline underline-offset-2 break-all`}
                  >
                    {credit.url}
                  </a>
                </div>
              ))}
            </div>

            <p className={`${theme.textMuted} text-[11px] font-light leading-relaxed opacity-70 mt-3`}>
              {VOICE_ENGINE_LICENCE_NOTE}
            </p>
          </div>

          {voicePackagePresent === true ? (
            <DeleteAction
              title="Удалить голосовой пакет"
              description="Удалит скачанный пакет распознавания речи из этого браузера. Аккаунт, беседы и память не затрагиваются. Перед следующей загрузкой мы снова спросим согласие."
              doneText="Голосовой пакет удалён."
              state={deleteVoiceState}
              onStart={handleDeleteVoicePackage}
              onCancel={() => setDeleteVoiceState('idle')}
              onConfirm={handleDeleteVoicePackage}
            />
          ) : voicePackagePresent === false ? (
            <p className={`${theme.textMuted} text-xs font-light px-1`}>
              Голосовой пакет не скачан — удалять нечего.
            </p>
          ) : null}
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
