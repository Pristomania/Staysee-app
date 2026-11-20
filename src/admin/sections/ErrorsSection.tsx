import type { AdminErrors } from '../../lib/admin/adminTypes';
import { formatMoscow } from '../../lib/admin/format';
import { Notice, SectionTitle, Table } from '../ui';
import { useAdminLoad } from '../useAdminLoad';

/** Errors of the last 7 days from the usage log: how many by code, and the latest ones. */
export function ErrorsSection() {
  const { data, error, loading } = useAdminLoad<AdminErrors>('errors', {});

  if (loading && !data) return <Notice tone="quiet">Загружаем…</Notice>;
  if (error || !data) return <Notice tone="error">{error ?? 'Нет данных.'}</Notice>;

  return (
    <div>
      <SectionTitle>По кодам за 7 дней</SectionTitle>
      {data.by_code.length === 0 ? (
        <Notice tone="quiet">Ошибок нет.</Notice>
      ) : (
        <Table head={['Код', 'Сколько']}>
          {data.by_code.map((item) => (
            <tr key={item.error_code}>
              <td className="px-3 py-2">{item.error_code}</td>
              <td className="px-3 py-2">{item.count}</td>
            </tr>
          ))}
        </Table>
      )}

      <SectionTitle>Последние</SectionTitle>
      {data.recent.length === 0 ? (
        <Notice tone="quiet">Нет.</Notice>
      ) : (
        <Table head={['Когда', 'Код', 'Что делала модель', 'Модель', 'Сообщение']}>
          {data.recent.map((item, index) => (
            <tr key={`${item.created_at}-${index}`}>
              <td className="whitespace-nowrap px-3 py-2">{formatMoscow(item.created_at)}</td>
              <td className="px-3 py-2">{item.error_code}</td>
              <td className="px-3 py-2">{item.call_kind ?? 'ответ'}</td>
              <td className="px-3 py-2">{item.model ?? '—'}</td>
              <td className="px-3 py-2 text-neutral-600">{item.error_message ?? ''}</td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
