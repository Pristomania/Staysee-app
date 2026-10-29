import { splitPhotoBlocks } from './photoBlocks';

function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

// The server writes exactly this (supabase/functions/_shared/imageAttachments.ts appendPhotoBlocks).
const saved =
  'Посмотри, пожалуйста\n\n[Фото 1: Лицо крупным планом, высыпания на лбу.]\n[Фото 2: Скриншот переписки.]';
same(splitPhotoBlocks(saved), {
  text: 'Посмотри, пожалуйста',
  photos: ['Лицо крупным планом, высыпания на лбу.', 'Скриншот переписки.'],
}, 'text and two photos');

same(splitPhotoBlocks('[Фото 1: Закат над морем.]'), { text: '', photos: ['Закат над морем.'] }, 'photo only');
same(splitPhotoBlocks('Просто текст'), { text: 'Просто текст', photos: [] }, 'plain text');
same(splitPhotoBlocks(''), { text: '', photos: [] }, 'empty');
same(splitPhotoBlocks(`${saved}\n\n`), splitPhotoBlocks(saved), 'trailing blank lines do not matter');

// Only lines at the very end, numbered 1..n in order, make cards. Anything else stays text.
const inTheMiddle = '[Фото 1: Посередине.]\nа дальше обычный текст';
same(splitPhotoBlocks(inTheMiddle), { text: inTheMiddle, photos: [] }, 'a line in the middle is text');
const wrongOrder = 'Текст\n\n[Фото 2: Не с первой.]';
same(splitPhotoBlocks(wrongOrder), { text: wrongOrder, photos: [] }, 'numbering must start at 1');
const typedByHand = 'Я написала [Фото 1: сама] в середине строки';
same(splitPhotoBlocks(typedByHand), { text: typedByHand, photos: [] }, 'inline brackets are text');

// A person who types the same format at the end gets a card; it is only text and harmless.
same(splitPhotoBlocks('Привет\n[Фото 1: набрано вручную]'), { text: 'Привет', photos: ['набрано вручную'] }, 'hand-typed card');

console.log('photoBlocks.cases.test.ts passed');
