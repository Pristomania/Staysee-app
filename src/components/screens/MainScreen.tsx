import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { User, Plus } from 'lucide-react';
import type { Conversation } from '../../types';
import { formatRelativeTime, GREETING } from './ChatScreen';
import { AppContainer } from '../layout';
import { filterVisibleConversations } from '../../lib/conversationFilters';

const MAX_ROOMS = 5;

interface Modal {
  type: 'rename' | 'delete';
  conv: Conversation;
}

export function MainScreen() {
  const { user } = useAuth();
  const { navigateTo, setCurrentConversation, setMessages, conversations, setConversations } = useApp();
  const { theme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [limitReached, setLimitReached] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) fetchConversations();
  }, [user]);

  useEffect(() => {
    if (!conversations.length) return;
    (async () => {
      const results: Record<string, string> = {};
      await Promise.all(
        conversations.map(async (conv) => {
          const { data } = await supabase
            .from('messages')
            .select('content')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (data) results[conv.id] = data.content;
        })
      );
      setPreviews(results);
    })();
  }, [conversations]);

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuId]);

  async function fetchConversations() {
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('user_id', user!.id)
      .eq('is_active', true)
      .order('last_message_at', { ascending: false })
      .limit(MAX_ROOMS + 1);
    setConversations(filterVisibleConversations(data || []));
    setLoading(false);
  }

  function greetingFor(convId: string) {
    return {
      id: 'greeting',
      conversation_id: convId,
      sender: 'ai' as const,
      content: GREETING,
      created_at: new Date().toISOString(),
    };
  }

  async function openRoom(conv: Conversation) {
    navigateTo('chat', { conversation: conv });
  }

  async function createNewRoom() {
    if (conversations.length >= MAX_ROOMS) {
      setLimitReached(true);
      setTimeout(() => setLimitReached(false), 4000);
      return;
    }
    const { data } = await supabase
      .from('conversations')
      .insert({ user_id: user!.id, title: '' })
      .select()
      .maybeSingle();
    if (data) {
      setMessages([greetingFor(data.id)]);
      navigateTo('chat', { conversation: data });
    }
  }

  function openMenu(e: React.MouseEvent, conv: Conversation) {
    e.stopPropagation();
    setOpenMenuId(openMenuId === conv.id ? null : conv.id);
  }

  function startRename(conv: Conversation) {
    setRenameValue(conv.title || '');
    setModal({ type: 'rename', conv });
    setOpenMenuId(null);
  }

  function startDelete(conv: Conversation) {
    setModal({ type: 'delete', conv });
    setOpenMenuId(null);
  }

  async function confirmRename() {
    if (!modal || modal.type !== 'rename') return;
    const title = renameValue.trim() || 'Новая беседа';
    await supabase.from('conversations').update({ title }).eq('id', modal.conv.id);
    setConversations(conversations.map(c => c.id === modal.conv.id ? { ...c, title } : c));
    setModal(null);
  }

  async function confirmDelete() {
    if (!modal || modal.type !== 'delete') return;
    const id = modal.conv.id;
    // Permanently delete messages first, then the conversation (cascade also handles it, but explicit is safer)
    await supabase.from('messages').delete().eq('conversation_id', id);
    await supabase.from('conversations').delete().eq('id', id);
    setConversations(conversations.filter(c => c.id !== id));
    setModal(null);
  }

  if (loading) {
    return (
      <div className={`min-h-screen ${theme.bg} flex items-center justify-center`}>
        <div className={`w-5 h-5 border-2 ${theme.spinnerBorder} ${theme.spinnerTop} rounded-full animate-spin`} />
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${theme.bg} flex flex-col`}>
      <AppContainer className="flex flex-col flex-1">
        {/* Header */}
        <div className="pt-10 sm:pt-14 pb-5 sm:pb-6 flex items-center justify-between">
          <div>
            <h1 className={`${theme.textPrimary} text-xl font-light`}>StaySee AI</h1>
            <p className={`${theme.textMuted} text-xs font-light mt-0.5`}>Ваши беседы</p>
          </div>
          <button
            onClick={() => navigateTo('profile')}
            aria-label="Контекст"
            className={`p-2.5 rounded-lg ${theme.surface} ${theme.surfaceHover} transition-colors duration-200`}
          >
            <User className={`w-4 h-4 ${theme.textSecondary}`} strokeWidth={1.5} />
          </button>
        </div>

      {/* Limit notice */}
      {limitReached && (
        <div className={`mb-4 px-5 py-3.5 rounded-xl border ${theme.surface} ${theme.border}`}>
          <p className={`${theme.textSecondary} text-sm font-light leading-relaxed`}>
            Пока можно открыть до пяти бесед. Можно вернуться в одну из уже начатых.
          </p>
        </div>
      )}

      {/* List */}
      <div className="flex-1 pb-8">
        {conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-16">
            <p className={`${theme.textSecondary} text-lg font-light mb-2`}>Здесь пока тихо.</p>
            <p className={`${theme.textMuted} text-sm font-light mb-10`}>Начните беседу, когда будете готовы.</p>
            <button
              onClick={createNewRoom}
              className={`px-8 py-3.5 rounded-lg border transition-all duration-300 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}`}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-wide`}>Начать беседу</span>
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 w-full">
            {conversations.map((conv, index) => {
              const preview = previews[conv.id];
              const title = conv.title || 'Новая беседа';
              const time = formatRelativeTime(conv.last_message_at);
              const isMenuOpen = openMenuId === conv.id;
              const isRecent = index === 0;

              return (
                <div key={conv.id} className="relative">
                  <button
                    onClick={() => openRoom(conv)}
                    className={`
                      w-full text-left px-5 py-4 rounded-xl border transition-all duration-200
                      ${theme.surface} ${theme.surfaceHover} ${theme.border}
                      ${isRecent ? 'ring-1 ring-[#c9a96e]/20 border-[#c9a96e]/15' : ''}
                    `}
                  >
                    <div className="flex items-start justify-between gap-2 pr-8">
                      <p className={`${theme.textPrimary} font-light text-[15px] leading-snug flex-1 min-w-0 truncate`}>
                        {title}
                      </p>
                      <span className={`${theme.textMuted} text-xs font-light flex-shrink-0 mt-0.5`}>{time}</span>
                    </div>
                    {preview && (
                      <p className={`${theme.textMuted} text-xs font-light mt-1.5 truncate pr-8`}>
                        {preview}
                      </p>
                    )}
                  </button>

                  {/* Menu trigger */}
                  <button
                    onClick={(e) => openMenu(e, conv)}
                    className={`
                      absolute right-2 top-2.5
                      w-9 h-9 flex items-center justify-center
                      rounded-lg
                      transition-all duration-200
                      ${theme.textSecondary}
                      ${isMenuOpen
                        ? `opacity-90 ${theme.surface} shadow-sm`
                        : 'opacity-55 hover:opacity-85 hover:bg-white/5'
                      }
                    `}
                    style={{ backdropFilter: 'blur(4px)' }}
                  >
                    <span className="text-[15px] leading-none tracking-[0.2em] select-none">···</span>
                  </button>

                  {/* Dropdown */}
                  {isMenuOpen && (
                    <div
                      ref={menuRef}
                      className={`absolute right-3 top-10 z-20 min-w-[148px] rounded-xl border shadow-lg overflow-hidden ${theme.surface} ${theme.border}`}
                      style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
                    >
                      <button
                        onClick={() => startRename(conv)}
                        className={`w-full text-left px-4 py-3 text-sm font-light transition-colors duration-150 ${theme.textSecondary} ${theme.surfaceHover}`}
                      >
                        Переименовать
                      </button>
                      <div className={`h-px ${theme.divider}`} />
                      <button
                        onClick={() => startDelete(conv)}
                        className={`w-full text-left px-4 py-3 text-sm font-light transition-colors duration-150 text-red-400/70 ${theme.surfaceHover}`}
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {conversations.length < MAX_ROOMS && (
              <button
                type="button"
                onClick={createNewRoom}
                className={`
                  w-full flex items-center justify-center gap-2 py-4 rounded-xl border mt-1.5
                  transition-all duration-300 active:scale-[0.99]
                  ${theme.surface} ${theme.surfaceHover} ${theme.border}
                  ${theme.btnBorderHover}
                `}
              >
                <Plus className={`w-3.5 h-3.5 ${theme.textSecondary}`} strokeWidth={1.5} />
                <span className={`${theme.textSecondary} font-light text-sm`}>Новая беседа</span>
              </button>
            )}
          </div>
        )}
      </div>
      </AppContainer>

      {/* Modals */}
      {modal && (
        <ModalOverlay onClose={() => setModal(null)}>
          {modal.type === 'rename' ? (
            <div className={`w-full max-w-xs mx-auto rounded-2xl border px-6 py-7 ${theme.surface} ${theme.border}`}
              style={{ boxShadow: '0 16px 48px rgba(0,0,0,0.24)' }}
            >
              <p className={`${theme.textPrimary} text-base font-light mb-5`}>Переименовать беседу</p>
              <input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && confirmRename()}
                className={`w-full border rounded-lg py-3 px-4 outline-none text-sm font-light transition-colors duration-200 mb-5
                  ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}`}
                placeholder="Название беседы"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setModal(null)}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}
                >
                  Отмена
                </button>
                <button
                  onClick={confirmRename}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover} ${theme.btnText}`}
                >
                  Сохранить
                </button>
              </div>
            </div>
          ) : (
            <div className={`w-full max-w-xs mx-auto rounded-2xl border px-6 py-7 ${theme.surface} ${theme.border}`}
              style={{ boxShadow: '0 16px 48px rgba(0,0,0,0.24)' }}
            >
              <p className={`${theme.textPrimary} text-base font-light mb-2`}>Удалить беседу?</p>
              <p className={`${theme.textSecondary} text-sm font-light mb-6 leading-[1.75]`}>
                Все сообщения будут удалены навсегда. Без возможности восстановления.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setModal(null)}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textSecondary}`}
                >
                  Отмена
                </button>
                <button
                  onClick={confirmDelete}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 border-red-400/20 bg-red-400/5 hover:bg-red-400/10 text-red-400/70`}
                >
                  Удалить
                </button>
              </div>
            </div>
          )}
        </ModalOverlay>
      )}
    </div>
  );
}

function ModalOverlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center px-6"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div onClick={e => e.stopPropagation()} className="w-full animate-fade-in">
        {children}
      </div>
    </div>
  );
}
