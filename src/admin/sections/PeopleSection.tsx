import { useState, type FormEvent } from 'react';
import type { AdminPeoplePage, AdminPersonCard } from '../../lib/admin/adminTypes';
import { describeAdminError, kindsForClass, labelChangeMessage, toPersonRow } from '../../lib/admin/adminViewModels';
import { costClassTitle, formatMoscow } from '../../lib/admin/format';
import { LabelSelect } from '../LabelSelect';
import { Notice, Pager, SectionTitle, Table } from '../ui';
import { useAdmin } from '../adminContext';
import { useAdminLoad } from '../useAdminLoad';

const PAGE = 50;

/** A label change that has been asked for and waits for the owner's "yes". */
interface PendingChange {
  userId: string;
  email: string;
  fromKey: string;
  fromTitle: string;
  toKey: string;
  toTitle: string;
}

/** Who a label change is about; what the label selects hand over when something is chosen in them. */
interface LabelTarget {
  userId: string;
  email: string;
  labelKey: string;
  labelTitle: string;
}

/**
 * People: search by the start of the e-mail, filter by label, the card of one person. The label is changed right where it is shown (in the
 * table and in the card): choosing another one asks first, in a bar that stays on screen, and only "Поменять" saves it (and logs it).
 */
export function PeopleSection() {
  const { labels, call } = useAdmin();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cardVersion, setCardVersion] = useState(0);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const people = useAdminLoad<AdminPeoplePage>('people', {
    ...(search ? { search } : {}),
    ...(labelFilter ? { label: labelFilter } : {}),
    limit: PAGE,
    offset,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setSearch(typed.trim());
  }

  function ask(target: LabelTarget, toKey: string) {
    if (toKey === target.labelKey) return;
    const toTitle = labels.find((label) => label.key === toKey)?.title ?? toKey;
    setNote(null);
    setPending({ userId: target.userId, email: target.email, fromKey: target.labelKey, fromTitle: target.labelTitle, toKey, toTitle });
  }

  async function confirmChange() {
    if (!pending || busy) return;
    setBusy(true);
    const result = await call('set_label', { user_id: pending.userId, label_key: pending.toKey });
    setBusy(false);
    if (!result.ok) {
      setNote({ text: describeAdminError(result.reason), error: true });
      setPending(null);
      return;
    }
    setNote({ text: `Метка поменяна: ${pending.email} теперь «${pending.toTitle}».`, error: false });
    setPending(null);
    setCardVersion((version) => version + 1);
    people.reload();
  }

  return (
    <div>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Почта (начало)"
          className="w-64 rounded border border-neutral-300 px-3 py-2 text-sm"
        />
        <select
          value={labelFilter}
          onChange={(event) => {
            setOffset(0);
            setLabelFilter(event.target.value);
          }}
          className="rounded border border-neutral-300 px-2 py-2 text-sm"
          aria-label="Показать только с меткой"
        >
          <option value="">Все метки</option>
          {labels.map((label) => (
            <option key={label.key} value={label.key}>
              {label.title}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded bg-neutral-900 px-3 py-2 text-sm text-white">
          Найти
        </button>
      </form>

      {pending && (
        <div className="sticky top-2 z-10 my-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm shadow">
          <span className="text-neutral-900">{labelChangeMessage(pending.email, pending.fromTitle, pending.toTitle)}</span>
          <button type="button" disabled={busy} onClick={() => void confirmChange()} className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50">
            {busy ? 'Меняем…' : 'Поменять'}
          </button>
          <button type="button" disabled={busy} onClick={() => setPending(null)} className="rounded border border-neutral-300 bg-white px-3 py-1">
            Отмена
          </button>
        </div>
      )}
      {note && <Notice tone={note.error ? 'error' : 'quiet'}>{note.text}</Notice>}

      {people.loading && !people.data && <Notice tone="quiet">Загружаем…</Notice>}
      {people.error && <Notice tone="error">{people.error}</Notice>}

      {people.data && (
        <>
          <div className="mt-3">
            <Table head={['Почта', 'Метка', 'Тариф', 'Регистрация', 'Последний вход', 'Бесед', 'Реплик', 'Польз. расход', 'Техн. расход']}>
              {people.data.rows.map((raw) => {
                const row = toPersonRow(raw);
                return (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className={`cursor-pointer hover:bg-neutral-50 ${selectedId === row.id ? 'bg-amber-50' : ''}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2">{row.email}</td>
                    <td className="px-3 py-2">
                      <LabelSelect
                        labels={labels}
                        valueKey={row.labelKey}
                        disabled={busy}
                        onPick={(toKey) => ask({ userId: row.id, email: row.email, labelKey: row.labelKey, labelTitle: row.label }, toKey)}
                      />
                    </td>
                    <td className="px-3 py-2">{row.tier}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.registered}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.lastLogin}</td>
                    <td className="px-3 py-2">{row.conversations}</td>
                    <td className="px-3 py-2">{row.messages}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.userCost}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.technicalCost}</td>
                  </tr>
                );
              })}
            </Table>
          </div>
          {people.data.rows.length === 0 && <Notice tone="quiet">Никого не нашли.</Notice>}
          <Pager total={people.data.total} limit={PAGE} offset={offset} onChange={setOffset} />
        </>
      )}

      {selectedId && (
        <PersonCardPanel
          key={`${selectedId}:${cardVersion}`}
          userId={selectedId}
          busy={busy}
          onAsk={ask}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function PersonCardPanel(props: { userId: string; busy: boolean; onAsk(target: LabelTarget, toKey: string): void; onClose(): void }) {
  const { labels } = useAdmin();
  const card = useAdminLoad<AdminPersonCard>('person', { user_id: props.userId });

  if (card.loading && !card.data) return <Notice tone="quiet">Загружаем карточку…</Notice>;
  if (card.error || !card.data) return <Notice tone="error">{card.error ?? 'Карточки нет.'}</Notice>;

  const { person } = card.data;
  const costGroups = (['user', 'technical'] as const)
    .map((costClass) => ({ costClass, kinds: kindsForClass(card.data?.costs.by_kind ?? [], costClass) }))
    .filter((group) => group.kinds.length > 0);

  return (
    <div className="mt-6 rounded-lg border border-neutral-300 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-neutral-900">{person.email}</div>
          <div className="mt-1 text-sm text-neutral-600">
            Регистрация {formatMoscow(person.registered_at)} · последний вход {formatMoscow(person.last_sign_in_at)} · тариф {person.tier ?? '—'}
            {card.data.tier?.is_suspended ? ' · приостановлен' : ''}
          </div>
          <div className="mt-1 text-sm text-neutral-600">
            Бесед {person.conversations}, реплик {person.user_messages}, ошибок за 7 дней {card.data.errors_7d}
          </div>
        </div>
        <button type="button" onClick={props.onClose} className="text-sm text-neutral-500 hover:text-neutral-900">
          Закрыть
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-600">Метка:</span>
        <LabelSelect
          labels={labels}
          valueKey={person.label_key}
          disabled={props.busy}
          onPick={(toKey) => props.onAsk({ userId: props.userId, email: person.email, labelKey: person.label_key, labelTitle: person.label_title }, toKey)}
        />
        <span className="text-neutral-500">
          ({costClassTitle(labels.find((label) => label.key === person.label_key)?.cost_class ?? 'user').toLowerCase()} расходы)
        </span>
      </div>

      <SectionTitle>Согласия</SectionTitle>
      {card.data.consents.length === 0 ? (
        <Notice tone="quiet">Нет записей.</Notice>
      ) : (
        <ul className="text-sm text-neutral-700">
          {card.data.consents.map((consent) => (
            <li key={`${consent.consent_type}-${consent.consented_at}`}>
              {consent.consent_type} (версия {consent.document_version}), {formatMoscow(consent.consented_at)}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Пакеты сообщений</SectionTitle>
      {card.data.packs.length === 0 ? (
        <Notice tone="quiet">Нет.</Notice>
      ) : (
        <ul className="text-sm text-neutral-700">
          {card.data.packs.map((pack) => (
            <li key={pack.purchased_at}>
              {pack.messages_left} из {pack.messages_total}, куплен {formatMoscow(pack.purchased_at)}, до {formatMoscow(pack.expires_at)}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Расходы за 30 дней</SectionTitle>
      {costGroups.length === 0 ? (
        <Notice tone="quiet">Нет.</Notice>
      ) : (
        costGroups.map((group) => (
          <div key={group.costClass} className="mb-3">
            <div className="text-sm font-medium text-neutral-800">{costClassTitle(group.costClass)}</div>
            <ul className="text-sm text-neutral-700">
              {group.kinds.map((item) => (
                <li key={item.kind}>
                  {item.kind}: {item.calls} вызовов, {item.usd}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <SectionTitle>Оценки</SectionTitle>
      <p className="text-sm text-neutral-700">
        Ответы: 👍 {card.data.feedback.answers.up} 👎 {card.data.feedback.answers.down} · Динамика: 👍 {card.data.feedback.dynamics.up} 👎{' '}
        {card.data.feedback.dynamics.down}
      </p>
    </div>
  );
}
