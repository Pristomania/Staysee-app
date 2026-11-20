import { useState, type FormEvent } from 'react';
import type { AdminPeoplePage, AdminPersonCard } from '../../lib/admin/adminTypes';
import { describeAdminError, labelChangeMessage, toPersonRow } from '../../lib/admin/adminViewModels';
import { costClassTitle, formatMoscow, formatUsd } from '../../lib/admin/format';
import { Chip, Notice, Pager, SectionTitle, Table } from '../ui';
import { useAdmin } from '../adminContext';
import { useAdminLoad } from '../useAdminLoad';

const PAGE = 50;

/** People: search by the start of the e-mail, filter by label, the card of one person, and the label (changed here, and logged). */
export function PeopleSection() {
  const { labels, call } = useAdmin();
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const colorOf = (key: string) => labels.find((label) => label.key === key)?.color ?? null;

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
          aria-label="Метка"
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
                      <Chip text={row.label} color={colorOf(row.labelKey)} />
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
          key={selectedId}
          userId={selectedId}
          onLabelChanged={people.reload}
          onClose={() => setSelectedId(null)}
          call={call}
        />
      )}
    </div>
  );
}

function PersonCardPanel(props: {
  userId: string;
  onLabelChanged(): void;
  onClose(): void;
  call: ReturnType<typeof useAdmin>['call'];
}) {
  const { labels } = useAdmin();
  const card = useAdminLoad<AdminPersonCard>('person', { user_id: props.userId });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function changeLabel(toKey: string) {
    const person = card.data?.person;
    if (!person || toKey === person.label_key || busy) return;
    const toTitle = labels.find((label) => label.key === toKey)?.title ?? toKey;
    if (!window.confirm(labelChangeMessage(person.email, person.label_title, toTitle))) return;
    setBusy(true);
    setMessage(null);
    const result = await props.call('set_label', { user_id: props.userId, label_key: toKey });
    setBusy(false);
    if (!result.ok) {
      setMessage(describeAdminError(result.reason));
      return;
    }
    setMessage('Метка поменяна.');
    card.reload();
    props.onLabelChanged();
  }

  if (card.loading && !card.data) return <Notice tone="quiet">Загружаем карточку…</Notice>;
  if (card.error || !card.data) return <Notice tone="error">{card.error ?? 'Карточки нет.'}</Notice>;

  const { person } = card.data;
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

      <div className="mt-4 flex items-center gap-2 text-sm">
        <label htmlFor="person-label" className="text-neutral-600">
          Метка
        </label>
        <select
          id="person-label"
          value={person.label_key}
          disabled={busy}
          onChange={(event) => void changeLabel(event.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          {labels.map((label) => (
            <option key={label.key} value={label.key}>
              {label.title} ({costClassTitle(label.cost_class).toLowerCase()} расходы)
            </option>
          ))}
        </select>
        {message && <span className="text-neutral-600">{message}</span>}
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
      {card.data.costs.by_kind.length === 0 ? (
        <Notice tone="quiet">Нет.</Notice>
      ) : (
        <ul className="text-sm text-neutral-700">
          {card.data.costs.by_kind.map((item) => (
            <li key={`${item.cost_class}-${item.kind}`}>
              {costClassTitle(item.cost_class)}: {item.kind}, {item.calls} вызовов, {formatUsd(item.usd)}
            </li>
          ))}
        </ul>
      )}

      <SectionTitle>Оценки</SectionTitle>
      <p className="text-sm text-neutral-700">
        Ответы: 👍 {card.data.feedback.answers.up} 👎 {card.data.feedback.answers.down} · Динамика: 👍 {card.data.feedback.dynamics.up} 👎{' '}
        {card.data.feedback.dynamics.down}
      </p>
    </div>
  );
}
