import { useEffect, useRef, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_COPY,
  pressThumb,
  saveComment,
  type FeedbackDeps,
  type FeedbackRating,
  type FeedbackState,
} from '../../lib/messageFeedback';
import type { useTheme } from '../../context/ThemeContext';

/** How long the quiet "write if you want" line stays under an answer when nobody touches it. */
const PROMPT_VISIBLE_MS = 10_000;

/**
 * Thumbs under an answer of Stacy. Small and quiet: two icons next to the time. Pressing one saves the mark at once;
 * then one line offers a short note ("if you want"), and only if the person presses "Написать" does a small box
 * open. Nothing is required, and the line goes away by itself.
 */
export function MessageFeedback(props: {
  conversationId: string;
  messageId: string;
  state: FeedbackState | null;
  onChange(next: FeedbackState | null): void;
  deps: FeedbackDeps;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const { conversationId, messageId, state, onChange, deps, theme } = props;
  const [prompting, setPrompting] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [noted, setNoted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!prompting || writing) return;
    const timer = window.setTimeout(() => setPrompting(false), PROMPT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [prompting, writing]);

  useEffect(() => {
    if (writing) textareaRef.current?.focus();
  }, [writing]);

  async function onThumb(rating: FeedbackRating) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setNoted(false);
    const result = await pressThumb(deps, { conversationId, messageId }, state, rating);
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    onChange(result.next);
    setWriting(false);
    setDraft('');
    setPrompting(result.next !== null);
  }

  async function onSend() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await saveComment(deps, { conversationId, messageId }, state, draft);
    setBusy(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    onChange(result.next);
    setNoted(Boolean(result.next?.comment));
    setWriting(false);
    setPrompting(false);
    setDraft('');
  }

  const iconClass = 'h-3.5 w-3.5';
  const buttonBase = `rounded-md p-1.5 -m-1 transition-opacity focus:outline-none focus-visible:ring-1 focus-visible:ring-[#c9a96e]/60 ${theme.textMuted}`;
  const pressed = (rating: FeedbackRating) => state?.rating === rating;
  const ask = state?.rating === -1 ? FEEDBACK_COPY.askBad : FEEDBACK_COPY.askGood;
  const placeholder = state?.rating === -1 ? FEEDBACK_COPY.placeholderBad : FEEDBACK_COPY.placeholderGood;

  return (
    <div className="mt-1" data-feedback-for={messageId}>
      <div role="group" aria-label="Оценка ответа" className="flex items-center gap-2">
        <button
          type="button"
          aria-label={FEEDBACK_COPY.good}
          title={FEEDBACK_COPY.good}
          aria-pressed={pressed(1)}
          disabled={busy}
          onClick={() => void onThumb(1)}
          className={`${buttonBase} ${pressed(1) ? 'text-[#c9a96e] opacity-100' : 'opacity-40 hover:opacity-100'}`}
        >
          <ThumbsUp className={`${iconClass} ${pressed(1) ? 'fill-current' : ''}`} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label={FEEDBACK_COPY.bad}
          title={FEEDBACK_COPY.bad}
          aria-pressed={pressed(-1)}
          disabled={busy}
          onClick={() => void onThumb(-1)}
          className={`${buttonBase} ${pressed(-1) ? 'text-[#c9a96e] opacity-100' : 'opacity-40 hover:opacity-100'}`}
        >
          <ThumbsDown className={`${iconClass} ${pressed(-1) ? 'fill-current' : ''}`} strokeWidth={1.5} />
        </button>
      </div>

      {state && prompting && !writing && (
        <p className={`mt-1 text-[12px] font-light leading-snug ${theme.textMuted}`} role="status">
          {ask}{' '}
          <button
            type="button"
            onClick={() => setWriting(true)}
            className="underline underline-offset-2 decoration-[#c9a96e]/50 hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#c9a96e]/60 rounded-sm"
          >
            {FEEDBACK_COPY.write}
          </button>
        </p>
      )}

      {state && writing && (
        <div className="mt-2 max-w-sm">
          <textarea
            ref={textareaRef}
            rows={2}
            value={draft}
            maxLength={FEEDBACK_COMMENT_MAX}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className={`w-full resize-none rounded-lg border px-3 py-2 text-[13px] font-light leading-relaxed outline-none ${theme.inputBg} ${theme.inputBorder} ${theme.inputBorderFocus} ${theme.inputText} ${theme.inputPlaceholder}`}
          />
          <div className="mt-1 flex items-center gap-4 text-[12px] font-light">
            <button
              type="button"
              disabled={busy || draft.trim() === ''}
              onClick={() => void onSend()}
              className={`${theme.btnText} underline underline-offset-2 decoration-[#c9a96e]/50 disabled:opacity-40 hover:opacity-80`}
            >
              {FEEDBACK_COPY.send}
            </button>
            <button
              type="button"
              onClick={() => {
                setWriting(false);
                setPrompting(false);
                setDraft('');
              }}
              className={`${theme.textMuted} hover:opacity-80`}
            >
              {FEEDBACK_COPY.skip}
            </button>
          </div>
        </div>
      )}

      {noted && !writing && (
        <p className={`mt-1 text-[12px] font-light ${theme.textMuted}`} role="status">
          {FEEDBACK_COPY.thanksNote}
        </p>
      )}

      {failed && (
        <p className={`mt-1 text-[12px] font-light ${theme.textMuted}`} role="alert">
          {FEEDBACK_COPY.failed}
        </p>
      )}
    </div>
  );
}
