import { useState } from 'react';
import type { AdminAnswerFeedbackRow, AdminDynamicsFeedbackRow, AdminFeedbackPage } from '../../lib/admin/adminTypes';
import { formatMoscow } from '../../lib/admin/format';
import { Notice, Pager } from '../ui';
import { useAdminLoad } from '../useAdminLoad';

const PAGE = 50;

type Kind = 'answers' | 'dynamics';

/** What people said under answers and under the weekly dynamics: the mark, the note, the person, and the text that was rated. */
export function FeedbackSection() {
  const [kind, setKind] = useState<Kind>('answers');
  const [onlyBad, setOnlyBad] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, error, loading } = useAdminLoad<AdminFeedbackPage<AdminAnswerFeedbackRow | AdminDynamicsFeedbackRow>>('feedback', {
    kind,
    ...(onlyBad ? { rating: -1 } : {}),
    limit: PAGE,
    offset,
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        {(['answers', 'dynamics'] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => {
              setOffset(0);
              setKind(item);
            }}
            className={`rounded border px-3 py-1 text-sm ${kind === item ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300'}`}
          >
            {item === 'answers' ? 'Ответы' : 'Динамика'}
          </button>
        ))}
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={onlyBad}
            onChange={(event) => {
              setOffset(0);
              setOnlyBad(event.target.checked);
            }}
          />
          Только «не понравилось»
        </label>
      </div>

      {loading && !data && <Notice tone="quiet">Загружаем…</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {data && (
        <>
          {data.rows.length === 0 && <Notice tone="quiet">Пока ничего нет.</Notice>}
          <ul className="mt-4 space-y-3">
            {data.rows.map((row, index) => (
              <li key={`${row.created_at}-${index}`} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-neutral-600">
                  <span className={row.rating === 1 ? 'text-green-700' : 'text-red-700'}>{row.rating === 1 ? '👍 хорошо' : '👎 плохо'}</span>
                  <span>{formatMoscow(row.created_at)}</span>
                  <span>{row.email ?? 'почта неизвестна'}</span>
                  <span>тариф {row.tier ?? '—'}</span>
                </div>
                {'reply_excerpt' in row ? (
                  <>
                    {row.previous_user_message && <p className="mt-2 text-neutral-500">Вопрос: «{row.previous_user_message}»</p>}
                    <p className="mt-1 whitespace-pre-wrap text-neutral-900">Ответ: «{row.reply_excerpt}»</p>
                  </>
                ) : (
                  <p className="mt-2 whitespace-pre-wrap text-neutral-900">
                    Динамика (неделя от {row.entry_date ?? '?'}): «{row.dynamics_excerpt}»
                  </p>
                )}
                {row.comment && <p className="mt-2 rounded bg-amber-50 p-2 text-neutral-900">Написали: «{row.comment}»</p>}
              </li>
            ))}
          </ul>
          <Pager total={data.total} limit={PAGE} offset={offset} onChange={setOffset} />
        </>
      )}
    </div>
  );
}
