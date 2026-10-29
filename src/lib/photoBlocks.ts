// A message with pictures is saved as the typed text, a blank line, then one line per picture:
//   [Фото 1: …description…]
// (supabase/functions/_shared/imageAttachments.ts writes it). The chat shows those lines as small photo cards.
// Only lines at the very end, numbered 1, 2, 3… in order, count; anything else stays ordinary text.

export interface PhotoBlocks {
  text: string;
  photos: string[];
}

const LINE = /^\[Фото (\d+): (.+)\]$/u;

export function splitPhotoBlocks(content: string): PhotoBlocks {
  const lines = content.trimEnd().split('\n');
  const found: Array<{ number: number; description: string }> = [];
  let end = lines.length;
  while (end > 0) {
    const match = LINE.exec(lines[end - 1].trimEnd());
    if (!match) break;
    found.unshift({ number: Number(match[1]), description: match[2] });
    end -= 1;
  }
  if (found.length === 0 || !found.every((entry, index) => entry.number === index + 1)) {
    return { text: content, photos: [] };
  }
  return {
    text: lines.slice(0, end).join('\n').trimEnd(),
    photos: found.map((entry) => entry.description),
  };
}
