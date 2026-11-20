export function parseServerTimestamp(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/
      .exec(value);
  if (!match) return NaN;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 ||
    Number(secondText) > 59 ||
    (match[7] !== "Z" && (Number(match[8]) > 23 || Number(match[9]) > 59))
  ) return NaN;
  return Date.parse(value);
}

/** Preserve PostgreSQL microseconds for entitlement comparisons; Date is only used for display. */
export function parseServerTimestampMicros(value: unknown): bigint | null {
  const ms = parseServerTimestamp(value);
  if (!Number.isFinite(ms)) return null;
  const fraction =
    /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value as string)?.[1] ?? "";
  return BigInt(Math.floor(ms / 1000)) * 1000000n +
    BigInt(fraction.padEnd(6, "0"));
}
