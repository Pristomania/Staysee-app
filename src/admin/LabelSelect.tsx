import type { AdminLabel } from '../lib/admin/adminTypes';

/**
 * The label of a person as a coloured word you press to get the list of the other labels. A real select, so the list is the browser's own
 * (it is never cut off by the table around it). Choosing only asks for a change: the screen confirms it before anything is saved, so the
 * select keeps showing the current label until the change is made.
 */
export function LabelSelect(props: { labels: AdminLabel[]; valueKey: string; disabled?: boolean; onPick(toKey: string): void }) {
  const current = props.labels.find((label) => label.key === props.valueKey);
  const color = current?.color ?? '#6b7280';
  return (
    // Pressing the label must not open the card of the person the row belongs to.
    <span className="relative inline-block" onClick={(event) => event.stopPropagation()}>
      <select
        aria-label="Метка"
        value={props.valueKey}
        disabled={props.disabled}
        onChange={(event) => props.onPick(event.target.value)}
        className="cursor-pointer appearance-none rounded-full py-0.5 pl-2 pr-5 text-xs text-white disabled:opacity-60"
        style={{ backgroundColor: color }}
      >
        {props.labels.map((label) => (
          // The list opens on the page's own colours, so the words are set dark on white whatever the select itself looks like.
          <option key={label.key} value={label.key} style={{ color: '#111827', backgroundColor: '#ffffff' }}>
            {label.title}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-white">
        ▾
      </span>
    </span>
  );
}
