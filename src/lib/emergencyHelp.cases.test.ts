/**
 * Run: npx tsx src/lib/emergencyHelp.cases.test.ts
 * The emergency help is a fixed text: the approved contacts, every number a link that dials it, and nothing else.
 */

import { EMERGENCY_HELP_COPY, emergencyHelpRowText } from './emergencyHelp';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const rows = EMERGENCY_HELP_COPY.rows.map((row) => emergencyHelpRowText(row));

assert(rows.length === 4, 'four rows: the Russian line, the emergency numbers, another country, the child line');
assert(rows[0] === 'В России для психологической кризисной поддержки есть линия МЧС +7 (495) 989-50-50.', 'the MChS line is named as approved');
assert(rows[1] === 'При непосредственной угрозе жизни или физической опасности нужны 112 или 103.', '112 and 103 are named as approved');
assert(rows[2] === 'В другой стране нужна местная экстренная служба, а психологическую кризисную поддержку можно найти на findahelpline.com.', 'another country: a local service and findahelpline.com');
assert(rows[3] === 'Для ребёнка, подростка или родителя, который обращается по поводу ребёнка, есть телефон 8-800-2000-122.', 'the child line is named as approved');

const links = EMERGENCY_HELP_COPY.rows.flatMap((row) => row.filter((part) => typeof part !== 'string')) as Array<{ label: string; href: string }>;
const hrefs = links.map((link) => link.href).sort();
assert(
  JSON.stringify(hrefs) === JSON.stringify(['https://findahelpline.com', 'tel:+74959895050', 'tel:103', 'tel:112', 'tel:88002000122']),
  'every number dials itself and the site opens: five links and no other',
);
for (const link of links.filter((l) => l.href.startsWith('tel:'))) {
  assert(link.href.replace(/\D/g, '') === link.label.replace(/\D/g, ''), `the link of ${link.label} dials the same digits`);
}

const digits = (rows.join(' ').match(/\d[\d\s\-()+]*\d|\d/g) ?? []).map((value) => value.replace(/\D/g, ''));
assert(digits.every((value) => ['74959895050', '112', '103', '88002000122', '2000122'].includes(value) || value === '989' ), `no other number appears: ${digits.join(', ')}`);
assert(EMERGENCY_HELP_COPY.title === 'Если сейчас очень тяжело', 'the title is calm and says nothing about a diagnosis');

console.log('All emergencyHelp cases passed.');
