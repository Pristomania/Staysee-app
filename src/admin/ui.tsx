import type { ReactNode } from 'react';
import { pageInfo } from '../lib/admin/adminViewModels';

/** Small shared pieces of the admin panel. Plain, light, no theme of the app: the panel is for one person at a desk. */

export function Card(props: { title: string; value?: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-neutral-500">{props.title}</div>
      {props.value !== undefined && <div className="mt-1 text-2xl font-semibold text-neutral-900">{props.value}</div>}
      {props.hint && <div className="mt-1 text-xs text-neutral-500">{props.hint}</div>}
      {props.children}
    </div>
  );
}

export function SectionTitle(props: { children: ReactNode }) {
  return <h2 className="mb-3 mt-6 text-sm font-semibold uppercase tracking-wide text-neutral-600">{props.children}</h2>;
}

export function Chip(props: { text: string; color?: string | null }) {
  const color = props.color ?? '#6b7280';
  return (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs text-white" style={{ backgroundColor: color }}>
      {props.text}
    </span>
  );
}

export function Notice(props: { children: ReactNode; tone?: 'error' | 'quiet' }) {
  return <p className={`my-3 text-sm ${props.tone === 'error' ? 'text-red-700' : 'text-neutral-500'}`}>{props.children}</p>;
}

/** "51–100 из 120" with two arrows. */
export function Pager(props: { total: number; limit: number; offset: number; onChange(offset: number): void }) {
  const info = pageInfo(props.total, props.limit, props.offset);
  return (
    <div className="mt-3 flex items-center gap-3 text-sm text-neutral-600">
      <button
        type="button"
        disabled={!info.hasPrev}
        onClick={() => props.onChange(Math.max(0, props.offset - props.limit))}
        className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40"
      >
        ←
      </button>
      <span>
        {info.from}–{info.to} из {props.total}
      </span>
      <button
        type="button"
        disabled={!info.hasNext}
        onClick={() => props.onChange(props.offset + props.limit)}
        className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-40"
      >
        →
      </button>
    </div>
  );
}

export function Table(props: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-neutral-50 text-xs uppercase tracking-wide text-neutral-500">
          <tr>
            {props.head.map((title) => (
              <th key={title} className="whitespace-nowrap px-3 py-2 font-medium">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">{props.children}</tbody>
      </table>
    </div>
  );
}
