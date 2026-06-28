/** Only manual notes may enter weekly-reflection generation; insight/tension stay private. */
export const WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE = "note" as const;

export function isWeeklyReflectionVisibleEntryType(entryType: string): boolean {
  return entryType === WEEKLY_REFLECTION_USER_MARK_ENTRY_TYPE;
}
