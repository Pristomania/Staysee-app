/*
 * PrivacyScreen — Политика конфиденциальности и управление данными
 */

import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { ScreenBackHeader, StickyScreenLayout, useSectionLabelClass } from '../layout';
import { LegalDocumentView } from '../legal/LegalDocumentView';
import { PRIVACY_META, PRIVACY_SECTIONS } from '../../content/legal/privacy';

type DeleteState = 'idle' | 'confirming' | 'loading' | 'done' | 'error';

export function PrivacyScreen() {
  const { navigateBack, setConversations, setMessages, setCurrentConversation } = useApp();
  const { user } = useAuth();
  const { theme } = useTheme();
  const sectionLabel = useSectionLabelClass();
  const [deleteAllState, setDeleteAllState] = useState<DeleteState>('idle');
  const [deleteMemoryState, setDeleteMemoryState] = useState<DeleteState>('idle');

  async function handleDeleteAllConversations() {
    if (!user) return;
    if (deleteAllState === 'idle') { setDeleteAllState('confirming'); return; }
    if (deleteAllState !== 'confirming') return;
    setDeleteAllState('loading');
    try {
      const { error } = await supabase.from('conversations').delete().eq('user_id', user.id);
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
    if (deleteMemoryState === 'idle') { setDeleteMemoryState('confirming'); return; }
    if (deleteMemoryState !== 'confirming') return;
    setDeleteMemoryState('loading');
    try {
      const { error } = await supabase.from('user_memory').delete().eq('user_id', user.id);
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
          onBack={() => navigateBack()}
          title="Конфиденциальность"
          subtitle="Политика обработки персональных данных"
          backLabel={user ? 'Назад' : 'Назад к регистрации'}
        />
      )}
    >
      <LegalDocumentView meta={PRIVACY_META} sections={PRIVACY_SECTIONS} />

      {user && (
        <section className="mt-10 pt-8 border-t border-white/10">
          <p className={sectionLabel}>Управление данными</p>

          <div className="space-y-2.5">
            <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5`}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1`}>Удалить все беседы</p>
              <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-3 opacity-85`}>
                Все сообщения и беседы будут удалены навсегда. Это действие нельзя отменить.
              </p>
              {deleteAllState === 'done' ? (
                <p className={`${theme.textMuted} text-xs font-light`}>Беседы удалены.</p>
              ) : deleteAllState === 'error' ? (
                <p className="text-red-400/60 text-xs font-light">Что-то пошло не так. Попробуйте позже.</p>
              ) : deleteAllState === 'confirming' ? (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDeleteAllState('idle')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}>
                    Отмена
                  </button>
                  <button type="button" onClick={handleDeleteAllConversations}
                    className="flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70">
                    Да, удалить всё
                  </button>
                </div>
              ) : (
                <button type="button" onClick={handleDeleteAllConversations} disabled={deleteAllState === 'loading'}
                  className="py-2 px-4 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70 disabled:opacity-40">
                  {deleteAllState === 'loading' ? 'Удаляю…' : 'Удалить все беседы'}
                </button>
              )}
            </div>

            <div className={`rounded-xl border ${theme.border} ${theme.surface} px-4 sm:px-5 py-3.5`}>
              <p className={`${theme.textPrimary} text-sm font-light mb-1`}>Удалить память AI</p>
              <p className={`${theme.textMuted} text-xs font-light leading-relaxed mb-3 opacity-85`}>
                Удалит сохранённые AI-заметки о ваших предпочтениях и темах. Беседы останутся.
              </p>
              {deleteMemoryState === 'done' ? (
                <p className={`${theme.textMuted} text-xs font-light`}>Память удалена.</p>
              ) : deleteMemoryState === 'error' ? (
                <p className="text-red-400/60 text-xs font-light">Что-то пошло не так. Попробуйте позже.</p>
              ) : deleteMemoryState === 'confirming' ? (
                <div className="flex gap-2">
                  <button type="button" onClick={() => setDeleteMemoryState('idle')}
                    className={`flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}>
                    Отмена
                  </button>
                  <button type="button" onClick={handleDeleteMemory}
                    className="flex-1 py-2 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70">
                    Да, удалить
                  </button>
                </div>
              ) : (
                <button type="button" onClick={handleDeleteMemory} disabled={deleteMemoryState === 'loading'}
                  className="py-2 px-4 rounded-lg border text-xs font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70 disabled:opacity-40">
                  {deleteMemoryState === 'loading' ? 'Удаляю…' : 'Удалить память AI'}
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </StickyScreenLayout>
  );
}