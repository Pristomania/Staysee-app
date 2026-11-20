import { useMemo, useState } from 'react';
import type { AdminCosts } from '../../lib/admin/adminTypes';
import { costsForClass } from '../../lib/admin/adminViewModels';
import { costClassTitle, type CostClass } from '../../lib/admin/format';
import { Card, Notice, SectionTitle, Table } from '../ui';
import { useAdminLoad } from '../useAdminLoad';

const PERIODS = [
  { days: 7, title: '7 дней' },
  { days: 30, title: '30 дней' },
  { days: 90, title: '90 дней' },
];

const CLASSES: CostClass[] = ['user', 'technical'];

function TabButton(props: { active: boolean; onClick(): void; children: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`rounded border px-3 py-1 text-sm ${props.active ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300'}`}
    >
      {props.children}
    </button>
  );
}

/** Costs of a period on two tabs, user and technical, each with its own total, what it went on, days and people. */
export function CostsSection() {
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<CostClass>('user');
  // The period is fixed when the choice is made (not on every render), so the request does not change by itself.
  const range = useMemo(() => {
    const now = Date.now();
    return { since: new Date(now - days * 86_400_000).toISOString(), until: new Date(now + 86_400_000).toISOString() };
  }, [days]);
  const { data, error, loading } = useAdminLoad<AdminCosts>('costs', range);

  const view = data ? costsForClass(data, tab) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {PERIODS.map((period) => (
          <TabButton key={period.days} active={days === period.days} onClick={() => setDays(period.days)}>
            {period.title}
          </TabButton>
        ))}
      </div>

      {loading && !data && <Notice tone="quiet">Загружаем…</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {data && view && (
        <>
          <div className="mt-5 flex flex-wrap gap-2 border-b border-neutral-200 pb-3">
            {CLASSES.map((costClass) => (
              <TabButton key={costClass} active={tab === costClass} onClick={() => setTab(costClass)}>
                {`${costClassTitle(costClass)} · ${costsForClass(data, costClass).total}`}
              </TabButton>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Card title={`${costClassTitle(tab)} расходы за период`} value={view.total} />
          </div>

          {view.empty ? (
            <Notice tone="quiet">За этот период здесь ничего нет.</Notice>
          ) : (
            <>
              <SectionTitle>На что ушло</SectionTitle>
              <Table head={['Что', 'Вызовов', 'Сумма']}>
                {view.kinds.map((item) => (
                  <tr key={item.kind}>
                    <td className="px-3 py-2">{item.kind}</td>
                    <td className="px-3 py-2">{item.calls}</td>
                    <td className="whitespace-nowrap px-3 py-2">{item.usd}</td>
                  </tr>
                ))}
              </Table>

              <SectionTitle>По дням (московское время)</SectionTitle>
              <Table head={['День', 'Сумма']}>
                {view.days.map((item) => (
                  <tr key={item.day}>
                    <td className="px-3 py-2">{item.day}</td>
                    <td className="whitespace-nowrap px-3 py-2">{item.usd}</td>
                  </tr>
                ))}
              </Table>

              <SectionTitle>Кто потратил больше всего</SectionTitle>
              <Table head={['Почта', 'Сумма']}>
                {view.people.map((item, index) => (
                  <tr key={`${item.email}-${index}`}>
                    <td className="px-3 py-2">{item.email}</td>
                    <td className="whitespace-nowrap px-3 py-2">{item.usd}</td>
                  </tr>
                ))}
              </Table>
            </>
          )}

          <Notice tone="quiet">
            Считаются вызовы, которые записало приложение, расходы удалённых аккаунтов (отдельная строка) и запуски вне приложения, если они записаны через
            общий журнал (тоже отдельная строка). Расходы аккаунтов, удалённых до 20 ноября 2026, были стёрты, их вернуть нельзя.
          </Notice>
        </>
      )}
    </div>
  );
}
