export function resizeChatComposer(
  textarea: { scrollHeight: number; scrollTop?: number; style: { height: string } } | null,
  maxHeight = 120,
  autoScrollToEnd = false,
): void {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  // Programmatic text (live dictation) doesn't move a caret, so nothing
  // else keeps the newest line in view once content overflows the cap.
  // Ordinary typing is left alone: the browser already follows the caret,
  // and forcing scrollTop here would fight a person who scrolled up to
  // re-read an earlier part of what they're typing.
  if (autoScrollToEnd) textarea.scrollTop = textarea.scrollHeight;
}
