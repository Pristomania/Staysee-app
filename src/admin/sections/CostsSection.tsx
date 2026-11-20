import { useMemo, useState } from 'react';
import type { AdminCosts } from '../../lib/admin/adminTypes';
import { splitCostTotals } from '../../lib/admin/adminViewModels';
import { costClassTitle, formatUsd } from '../../lib/admin/format';
import { Card, Notice, SectionTitle, Table } from '../ui';
import { useAdminLoad } from '../useAdminLoad';

const PERIODS = [
  { days: 7, title: '7 дней' },
  { days: 30, title: '30 дней' },
  { days: 90, title: '90 дней' },
];

/** Costs of a period, split into user and technical: totals, by day, by what they went on, by person. */
export function CostsSection() {
  const [days, setDays] = useState(30);
  // The period is fixed when the choice is made (not on every render), so the request does not change by itself.
  const range = useMemo(() => {
    const now = Date.now();
    return { since: new Date(now - days * 86_400_000).toISOString(), until: new Date(now + 86_400_000).toISOString() };
  }, [days]);
  const { data, error, loading } = useAdminLoad<AdminCosts>('costs', range);

  return (
    <div>
      <div className="flex gap-2">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            type="button"
            onClick={() => setDays(period.days)}
            className={`rounded border px-3 py-1 text-sm ${days === period.days ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300'}`}
          >
            {period.title}
          </button>
        ))}
      </div>

      {loading && !data && <Notice tone="quiet">Загружаем…</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {data && (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {splitCostTotals(data.totals).map((card) => (
              <Card key={card.title} title={card.title} value={card.value} />
            ))}
          </div>

          <SectionTitle>На что ушло</SectionTitle>
          <Table head={['Расходы', 'Что', 'Вызовов', 'Сумма']}>
            {data.by_kind.map((item) => (
              <tr key={`${item.cost_class}-${item.kind}`}>
                <td className="px-3 py-2">{costClassTitle(item.cost_class)}</td>
                <td className="px-3 py-2">{item.kind}</td>
                <td className="px-3 py-2">{item.calls}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatUsd(item.usd)}</td>
              </tr>
            ))}
          </Table>

          <SectionTitle>По дням (московское время)</SectionTitle>
          <Table head={['День', 'Расходы', 'Сумма']}>
            {data.by_day.map((item) => (
              <tr key={`${item.day}-${item.cost_class}`}>
                <td className="px-3 py-2">{item.day}</td>
                <td className="px-3 py-2">{costClassTitle(item.cost_class)}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatUsd(item.usd)}</td>
              </tr>
            ))}
          </Table>

          <SectionTitle>Кто потратил больше всего</SectionTitle>
          <Table head={['Почта', 'Расходы', 'Сумма']}>
            {data.by_person.map((item) => (
              <tr key={`${item.user_id}-${item.cost_class}`}>
                <td className="px-3 py-2">{item.email ?? '—'}</td>
                <td className="px-3 py-2">{costClassTitle(item.cost_class)}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatUsd(item.usd)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
