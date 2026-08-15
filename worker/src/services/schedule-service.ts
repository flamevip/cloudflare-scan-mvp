const DAILY_RETENTION_HOUR_UTC = 3;

export function shouldRunDailyRetention(scheduledTime: number): boolean {
  if (!Number.isFinite(scheduledTime)) return false;
  const scheduledAt = new Date(scheduledTime);
  return scheduledAt.getUTCHours() === DAILY_RETENTION_HOUR_UTC
    && scheduledAt.getUTCMinutes() === 0;
}
