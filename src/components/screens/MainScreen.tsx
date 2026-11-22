import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { usePlan } from '../../context/PlanContext';
import { useApp } from '../../context/AppContext';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { User, Plus, Lock, ArrowUp } from 'lucide-react';
import {conversationClient} from '../../lib/conversationAccessBrowser';
import type {PlanId} from '../../lib/plans';
import type {Message} from '../../types';
import {ConversationOrderControls} from '../ConversationOrderControls';
import type { Conversation } from '../../types';
import { GREETING } from './ChatScreen';
import { FIRST_CONTACT_MESSAGE, isFirstConversation } from '../../lib/firstContact';
import { insertChatMessage } from '../../lib/chatMessages';
import { formatRelativeTime } from '../../lib/chatPresentation';
import { AppContainer } from '../layout';
import { PlanVerificationNotice } from '../PlanVerificationNotice';
import {
  canCreateFromConversationList,
  roomLimitNotice,
} from '../../lib/roomLimits';

interface Modal {
  type: 'rename' | 'delete';
  conv: Conversation;
}

export function MainScreen() {
  const { user } = useAuth();
  const { tier, loaded: planLoaded, maxConversations,accessRevision,verificationError,refresh } = usePlan();
  const { navigateTo, setMessages, conversations, setConversations } = useApp();
  return <ConversationListScreen userId={user?.id??null} tier={tier} planLoaded={planLoaded} maxConversations={maxConversations}
   revision={accessRevision} planFailed={verificationError} onRetryPlan={refresh} navigateTo={navigateTo} setMessages={setMessages} conversations={conversations} setConversations={setConversations}/>;
}
async function createBrowserRoom(userId:string):Promise<Conversation>{
 const {data,error}=await supabase.from('conversations').insert({user_id:userId,title:''}).select('id,user_id,title,is_active,created_at,last_message_at').maybeSingle();
 if(error||!data)throw Error(error?.message??'room_create_failed');return {...data,can_read:true};
}
/** Explicit application boundaries support production and isolated acceptance without live accounts. */
export function ConversationListScreen({userId,tier,planLoaded,maxConversations,revision='',planFailed=false,onRetryPlan=()=>{},navigateTo,setMessages,conversations,setConversations,client=conversationClient,createRoom=createBrowserRoom}:{
 userId:string|null;tier:PlanId;planLoaded:boolean;maxConversations:number;
 revision?:string;
 planFailed?:boolean;onRetryPlan?:()=>void;
 navigateTo:ReturnType<typeof useApp>['navigateTo'];setMessages:React.Dispatch<React.SetStateAction<Message[]>>;
 conversations:Conversation[];setConversations:(rows:Conversation[])=>void;
 client?:typeof conversationClient;createRoom?:(userId:string)=>Promise<Conversation>;
}){
  const { theme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [limitReached, setLimitReached] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [listKey,setListKey]=useState('');
  const [orderingId,setOrderingId]=useState<string|null>(null);
  const moveTicket=useRef<{key:string}|null>(null);
  const identityKey=`${userId}:${tier}:${planLoaded}:${maxConversations}:${revision}`;
  const currentKey=useRef(identityKey);currentKey.current=identityKey;
  const fetchVersion=useRef(0);
  useEffect(()=>{
   setBusy(false);setModal(null);setOpenMenuId(null);setOrderingId(null);setError('');moveTicket.current=null;
   return()=>{moveTicket.current=null;};
  },[identityKey]);
  useEffect(()=>{if(orderingId&&!conversations.some(c=>c.id===orderingId))setOrderingId(null);},[conversations,orderingId]);
  const menuRef = useRef<HTMLDivElement>(null);
  const limitTimerRef = useRef<number | undefined>(undefined);

  const fetchConversations = useCallback(async () => {
    if (!userId||!planLoaded) return false;
    const version=++fetchVersion.current;
    try{
     const data=await client.list(userId);
     if(currentKey.current!==identityKey||version!==fetchVersion.current)return false;
     setConversations(data);setListKey(identityKey);setError('');return true;
    }catch{if(currentKey.current===identityKey)setError('Не удалось загрузить беседы. Попробуйте ещё раз.');return false;}
    finally{if(currentKey.current===identityKey)setLoading(false);}
  }, [client,identityKey,planLoaded,setConversations,userId]);

  useEffect(() => {
    void fetchConversations();
    return()=>{fetchVersion.current+=1;};
  }, [fetchConversations]);

  useEffect(() => {
    setPreviews({});
    if (!planLoaded||listKey!==identityKey||!conversations.length) return;
    let active=true;
    (async () => {
      // One round trip for every conversation's preview instead of one
      // query per conversation -- see load_conversation_last_messages
      // (migration 063) for why.
      const data=await client.previews(conversations.filter(conv=>conv.can_read===true).map(conv=>conv.id)).catch(()=>({}));
      if(active&&currentKey.current===identityKey)setPreviews((data ?? {}) as Record<string, string>);
    })();
    return()=>{active=false;};
  }, [client,conversations,planLoaded,listKey,identityKey]);

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
    if(conv.can_read!==true){setError('Ваши данные сохранены. Беседа будет доступна после оплаты.');return;}
    navigateTo('chat', { conversation: conv });
  }

  useEffect(() => () => window.clearTimeout(limitTimerRef.current), []);

  function showLimitNotice() {
    setLimitReached(true);
    window.clearTimeout(limitTimerRef.current);
    limitTimerRef.current = window.setTimeout(() => setLimitReached(false), 8000);
  }

  async function createNewRoom() {
    if(!userId||!planLoaded||busy||listKey!==identityKey)return;
    if (!canCreateFromConversationList(conversations, maxConversations)) {
      showLimitNotice();
      return;
    }
    setBusy(true);setError('');const key=identityKey;
    try{const data=await createRoom(userId);
      if(currentKey.current!==key)return;
      if (!loading && isFirstConversation(conversations.length)) {
        // The very first conversation of the account opens with the introduction, saved as a message of Stacy: it is shown like
        // any message and the model reads it as history with the first answer.
        const introduction = await insertChatMessage(data.id, 'ai', FIRST_CONTACT_MESSAGE, { userId });
        if(currentKey.current!==key)return;
        setMessages([introduction.message ?? greetingFor(data.id)]);
      } else {
        setMessages([greetingFor(data.id)]);
      }
      navigateTo('chat', { conversation: data });
    }catch(err){if(currentKey.current===key){if(err instanceof Error&&/conversation_limit_reached/.test(err.message))showLimitNotice();else setError('Не удалось создать беседу. Попробуйте ещё раз.');}}
    finally{if(currentKey.current===key)setBusy(false);}
  }

  function openMenu(e: React.MouseEvent, conv: Conversation) {
    e.stopPropagation();
    if(busy)return;
    setOpenMenuId(openMenuId === conv.id ? null : conv.id);
  }

  function startRename(conv: Conversation) {
    if(busy)return;setError('');
    setRenameValue(conv.title || '');
    setModal({ type: 'rename', conv });
    setOpenMenuId(null);
  }

  function startDelete(conv: Conversation) {
    if(busy)return;setError('');
    setModal({ type: 'delete', conv });
    setOpenMenuId(null);
  }

  async function confirmRename() {
    if (!modal || modal.type !== 'rename'||busy) return;
    const title = renameValue.trim() || 'Новая беседа';
    setBusy(true);setError('');const key=identityKey;
    try{await client.rename(modal.conv.id,title);if(currentKey.current===key){setModal(null);await fetchConversations();}}
    catch{if(currentKey.current===key)setError('Не удалось переименовать беседу. Попробуйте ещё раз.');}
    finally{if(currentKey.current===key)setBusy(false);}
  }

  async function confirmDelete() {
    if (!modal || modal.type !== 'delete'||busy) return;
    const id = modal.conv.id;
    setBusy(true);setError('');const key=identityKey;
    try{await client.remove(id);if(currentKey.current===key){setConversations(conversations.filter(c=>c.id!==id));setModal(null);await fetchConversations();}}
    catch{if(currentKey.current===key)setError('Не удалось удалить беседу. Она остаётся в списке. Попробуйте ещё раз.');}
    finally{if(currentKey.current===key)setBusy(false);}
  }

  const canReorder=planLoaded&&tier!=='free';
  async function moveStep(id:string,direction:'up'|'down'){
   if(!canReorder||busy||listKey!==identityKey||moveTicket.current?.key===identityKey)return;
   const index=conversations.findIndex(c=>c.id===id);
   const neighbor=conversations[index+(direction==='up'?-1:1)];
   if(index<0||!neighbor)return;
   const ticket={key:identityKey};moveTicket.current=ticket;setBusy(true);setError('');
   try{
    await client.moveStep(id,direction,neighbor.id);
    if(currentKey.current===ticket.key&&moveTicket.current===ticket){
     const refreshed=await fetchConversations();
     if(!refreshed&&currentKey.current===ticket.key&&moveTicket.current===ticket){setListKey('');setPreviews({});}
    }
   }
   catch(err){
    if(currentKey.current===ticket.key&&moveTicket.current===ticket){
     // A refused/uncertain mutation revokes the old list authority immediately,
     // including previews. A failed refresh must never leave stale readable rows.
     setListKey('');setPreviews({});
     const locked=err instanceof Error&&err.message==='conversation_locked';
     if(locked){setOrderingId(null);void onRetryPlan();}
     const refreshed=await fetchConversations();
     if(currentKey.current===ticket.key&&moveTicket.current===ticket){
      if(locked)setError('Перестановка доступна только с действующим тарифом. Ваши данные сохранены.'+(refreshed?'':' Не удалось обновить список.'));
      else if(err instanceof Error&&err.message==='conversation_order_changed')setError(refreshed
       ?'Порядок бесед изменился. Список обновлён — выберите направление ещё раз.'
       :'Порядок бесед мог измениться. Не удалось обновить список. Нажмите «Обновить список».');
      else setError(refreshed?'Не удалось подтвердить перемещение. Список обновлён — проверьте порядок.'
       :'Не удалось подтвердить перемещение и обновить список. Нажмите «Обновить список».');
     }
    }
   }
   finally{if(moveTicket.current===ticket){moveTicket.current=null;if(currentKey.current===ticket.key)setBusy(false);}}
  }

  if (!planLoaded) return <PlanVerificationNotice key={userId??'guest'} failed={planFailed} onRetry={onRetryPlan}/>;

  if ((loading||listKey!==identityKey)&&!error) {
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
      {error&&!modal&&<div role="alert" className={`mb-4 text-sm ${theme.textSecondary}`}><p>{error}</p>
       {!modal&&<button type="button" className="underline p-2" onClick={()=>void fetchConversations()}>Обновить список</button>}
       {error.includes('после оплаты')&&<button type="button" className="underline p-2" onClick={()=>navigateTo('tariffs')}>Посмотреть тарифы</button>}
      </div>}
      {canReorder&&<p className={`mb-4 text-xs ${theme.textMuted}`}>После окончания оплаты останется доступна верхняя беседа. Переместите наверх ту, которую хотите оставить.</p>}
      {limitReached && (
        <div className={`mb-4 px-5 py-3.5 rounded-xl border ${theme.surface} ${theme.border}`}>
          <p className={`${theme.textSecondary} text-sm font-light leading-relaxed`}>
            {roomLimitNotice(tier, maxConversations)}
          </p>
        </div>
      )}

      {/* List */}
      <div className="flex-1 pb-8">
        {listKey!==identityKey ? <p className={`${theme.textMuted} text-sm`}>Список бесед пока недоступен.</p> : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pb-16">
            <p className={`${theme.textSecondary} text-lg font-light mb-2`}>Здесь пока тихо.</p>
            <p className={`${theme.textMuted} text-sm font-light mb-10`}>Начните беседу, когда будете готовы.</p>
            <button
              onClick={createNewRoom}
              disabled={busy}
              className={`px-8 py-3.5 rounded-lg border transition-all duration-300 ${theme.btnBg} ${theme.btnBgHover} ${theme.btnBorder} ${theme.btnBorderHover}`}
            >
              <span className={`${theme.btnText} font-light text-sm tracking-wide`}>Начать беседу</span>
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 w-full">
            {(listKey===identityKey?conversations:[]).map((conv, index) => {
              const preview = conv.can_read===true?previews[conv.id]:null;
              const title = conv.title || 'Новая беседа';
              const time = formatRelativeTime(conv.last_message_at);
              const isMenuOpen = openMenuId === conv.id;
              const isRecent = index === 0;

              return (
                <div key={conv.id} className={`relative ${orderingId===conv.id?'ring-1 ring-[#c9a96e] rounded-xl':''}`}>
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
                        {conv.can_read!==true&&<Lock className="inline w-3.5 h-3.5 mr-2" aria-label="Беседа закрыта"/>}{title}
                      </p>
                      <span className={`${theme.textMuted} text-xs font-light flex-shrink-0 mt-0.5`}>{time}</span>
                    </div>
                    {preview && (
                      <p className={`${theme.textMuted} text-xs font-light mt-1.5 truncate pr-8`}>
                        {preview}
                      </p>
                    )}
                    {conv.can_read!==true&&<p className={`${theme.textMuted} text-xs mt-1.5 pr-8`}>Данные сохранены. Доступно после оплаты.</p>}
                  </button>

                  {/* Menu trigger */}
                  <button
                    onClick={(e) => openMenu(e, conv)}
                    type="button" aria-label={`Меню беседы «${title}»`}
                    aria-expanded={isMenuOpen}
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
                      {canReorder&&conversations.length>1&&<button type="button" disabled={busy} onClick={()=>{setOrderingId(conv.id);setOpenMenuId(null);}} className={`w-full text-left px-4 py-3 text-sm ${theme.textSecondary}`}><ArrowUp className="inline w-3.5 h-3.5 mr-1"/>Изменить порядок</button>}
                      <div className={`h-px ${theme.divider}`} />
                      <button
                        onClick={() => startDelete(conv)}
                        className={`w-full text-left px-4 py-3 text-sm font-light transition-colors duration-150 text-red-400/70 ${theme.surfaceHover}`}
                      >
                        Удалить
                      </button>
                    </div>
                  )}
                  {canReorder&&orderingId===conv.id&&<div className={theme.textSecondary}><ConversationOrderControls first={index===0} last={index===conversations.length-1} saving={busy} onMove={direction=>void moveStep(conv.id,direction)} onDone={()=>setOrderingId(null)}/></div>}
                </div>
              );
            })}

            {(
              <button
                type="button"
                onClick={createNewRoom}
                disabled={busy}
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
        <ModalOverlay onClose={() => {if(!busy)setModal(null);}}>
          {error&&<p role="alert" className="text-red-300 bg-[#16221d] rounded p-3 mb-2 text-sm">{error}</p>}
          {modal.type === 'rename' ? (
            <div className={`w-full max-w-xs mx-auto rounded-2xl border px-6 py-7 ${theme.surface} ${theme.border}`}
              style={{ boxShadow: '0 16px 48px rgba(0,0,0,0.24)' }}
            >
              <p className={`${theme.textPrimary} text-base font-light mb-5`}>Переименовать беседу</p>
              <input
                autoFocus
                value={renameValue}
                maxLength={200}
                onChange={e => setRenameValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && confirmRename()}
                className={`w-full border rounded-lg py-3 px-4 outline-none text-sm font-light transition-colors duration-200 mb-5
                  ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}`}
                placeholder="Название беседы"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setModal(null)}
                  disabled={busy}
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textMuted}`}
                >
                  Отмена
                </button>
                <button
                  onClick={confirmRename}
                  disabled={busy}
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
                  disabled={busy} autoFocus
                  className={`flex-1 py-2.5 rounded-lg border text-sm font-light transition-colors duration-200 ${theme.btnBg} ${theme.btnBorder} ${theme.textSecondary}`}
                >
                  Отмена
                </button>
                <button
                  onClick={confirmDelete}
                  disabled={busy}
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
      role="dialog" aria-modal="true" aria-label="Действие с беседой"
      className="fixed inset-0 z-30 flex items-center justify-center px-6"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
      onKeyDown={event=>{
        if(event.key==='Escape'){event.stopPropagation();onClose();}
        if(event.key==='Tab'){
          const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
          const first=nodes[0],last=nodes[nodes.length-1];
          if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
          else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
        }
      }}
    >
      <div onClick={e => e.stopPropagation()} className="w-full animate-fade-in">
        {children}
      </div>
    </div>
  );
}
