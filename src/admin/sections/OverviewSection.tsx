import type { AdminOverview } from '../../lib/admin/adminTypes';
import { splitCostTotals } from '../../lib/admin/adminViewModels';
import { Card, Chip, Notice, SectionTitle } from '../ui';
import { useAdminLoad } from '../useAdminLoad';
import { useAdmin } from '../adminContext';

/** The front page: people, tariffs, the two kinds of costs, errors, ratings. */
export function OverviewSection() {
  const { labels } = useAdmin();
  const { data, error, loading } = useAdminLoad<AdminOverview>('overview', {});

  if (loading && !data) return <Notice tone="quiet">Загружаем…</Notice>;
  if (error || !data) return <Notice tone="error">{error ?? 'Нет данных.'}</Notice>;

  const colorOf = (key: string) => labels.find((label) => label.key === key)?.color ?? null;

  return (
    <div>
      <SectionTitle>Люди</SectionTitle>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title="Всего аккаунтов" value={String(data.people.total)} />
        <Card title="Регистраций за 7 дней" value={String(data.people.registered_7d)} />
        <Card title="Регистраций за 30 дней" value={String(data.people.registered_30d)} />
        <Card title="Ошибок за 7 дней" value={String(data.errors_7d)} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card title="По меткам">
          <div className="mt-2 flex flex-wrap gap-2">
            {data.people.by_label.map((item) => (
              <span key={item.key} className="flex items-center gap-1 text-sm">
                <Chip text={item.title} color={colorOf(item.key)} />
                <span className="text-neutral-700">{item.count}</span>
              </span>
            ))}
          </div>
        </Card>
        <Card title="По тарифам">
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-neutral-700">
            {data.people.by_tier.map((item) => (
              <span key={item.tier}>
                {item.tier}: <b>{item.count}</b>
              </span>
            ))}
          </div>
        </Card>
      </div>

      <SectionTitle>Расходы за 30 дней</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        {splitCostTotals(data.costs).map((card) => (
          <Card key={card.title} title={card.title} value={card.value} />
        ))}
      </div>

      <SectionTitle>Оценки</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Ответы Стейси" value={`👍 ${data.feedback.answers.up}   👎 ${data.feedback.answers.down}`} />
        <Card title="Динамика" value={`👍 ${data.feedback.dynamics.up}   👎 ${data.feedback.dynamics.down}`} />
      </div>
    </div>
  );
}
