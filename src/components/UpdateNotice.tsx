import { useEffect, useState } from 'react';
import { UPDATE_NOTICE_COPY } from '../lib/appUpdate';
import { startAppUpdateWatcher } from '../lib/appUpdateWatcher';

/**
 * Watches for a new version of the site while the page is open, and says so with one quiet line and a button when the
 * page could not be refreshed by itself (the person is typing or looking at it). Rendered once, over every screen.
 */
export function UpdateNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => startAppUpdateWatcher(() => setVisible(true)), []);

  if (!visible) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-3 z-50 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-full border border-white/15 bg-[#161b2a]/95 px-4 py-2 text-xs font-light text-[#e8e4dc] shadow-lg backdrop-blur"
    >
      <span>{UPDATE_NOTICE_COPY.text}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-full border border-[#c9a96e]/40 px-3 py-1 text-[#c9a96e]"
      >
        {UPDATE_NOTICE_COPY.button}
      </button>
    </div>
  );
}
