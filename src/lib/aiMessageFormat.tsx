import type { ReactNode } from 'react';
import { sanitizeProfanityInReply } from './languageGuard';

const LEGACY_TAIL_RE =
  /\n*\(Мысль ещё не закончилась[^)]*\)\s*$/i;

function stripOrphanContinueMarkers(text: string): string {
  return text
    .replace(/([—–-])\s*\n+\s*дальше[.!…:]*\s*\n+\s*/giu, '$1 ')
    .replace(/\n{2,}\s*дальше[.!…:]*\s*\n{2,}/giu, '\n\n')
    .replace(/(^|\n)\s*дальше[.!…:]*\s*(?=\n)/giu, '$1')
    .replace(/\s+дальше[.!…:]*\s+(?=[а-яё])/giu, ' ')
    .trim();
}

export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*•]\s+/gm, '');
}

export interface AiMessageStyle {
  baseTextClass: string;
}

/** Matches Context screen paragraph spacing (ProfileScreen block.text). */
const PARA_CLASS = 'mb-2.5 last:mb-0';

/** Single pipeline for save, stream, and final render — avoids layout shifts at handoff. */
export function prepareAiDisplayText(text: string): string {
  const stripped = stripOrphanContinueMarkers(
    stripMarkdownFormatting(text)
      .replace(LEGACY_TAIL_RE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
  return sanitizeProfanityInReply(stripped);
}

/** @deprecated Use prepareAiDisplayText */
export function polishAiDisplayText(text: string): string {
  return prepareAiDisplayText(text);
}

/** Atomic reveal pieces (paragraphs or sentences inside long blocks). */
export function splitRevealUnits(displayText: string): string[] {
  const t = displayText.trim();
  if (!t) return [];

  const paragraphs = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const units: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= 160) {
      units.push(para);
      continue;
    }
    const sentences = para
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length >= 2) {
      units.push(...sentences);
    } else {
      units.push(para);
    }
  }

  return units.length > 0 ? units : [t];
}

/**
 * Monotonic prefixes of the final display text — each step only extends, never rewrites.
 * Prevents duplicate lines and "stretch / shrink" during streaming.
 */
export function buildRevealSteps(displayText: string): string[] {
  const t = displayText.trim();
  if (!t) return [];

  const units = splitRevealUnits(t);
  const steps: string[] = [];
  let cursor = 0;

  for (const unit of units) {
    const idx = t.indexOf(unit, cursor);
    if (idx < 0) continue;
    const end = idx + unit.length;
    const slice = t.slice(0, end);
    const prev = steps[steps.length - 1];
    if (!prev || slice.length > prev.length) {
      steps.push(slice);
    }
    cursor = end;
  }

  if (steps.length === 0) return [t];
  if (steps[steps.length - 1] !== t) steps.push(t);

  return steps.filter((s, i, arr) => i === 0 || s !== arr[i - 1]);
}

export function shouldAnimateReveal(displayText: string): boolean {
  return buildRevealSteps(displayText).length > 1;
}

/** Render AI text — paragraph blocks; stable when `text` only grows by prefix. */
export function renderAiMessageBody(
  rawText: string,
  style: AiMessageStyle,
  options?: { prepared?: boolean },
): ReactNode {
  const normalized = options?.prepared
    ? rawText.trim()
    : prepareAiDisplayText(rawText);
  const paragraphs = normalized.split(/\n\n+/).filter((p) => p.trim());

  if (paragraphs.length === 0) return null;

  return paragraphs.map((para, pi) => (
    <p key={pi} className={`${style.baseTextClass} ${PARA_CLASS}`}>
      {para.trim()}
    </p>
  ));
}
