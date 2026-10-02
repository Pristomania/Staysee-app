export function resizeChatComposer(
  textarea: { scrollHeight: number; style: { height: string } } | null,
  maxHeight = 120,
): void {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
}
