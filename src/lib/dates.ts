// Days and moments as the app writes them. A local day number is the days since 1970-01-01 on this Mac,
// as history.rs counts them.
export const DAY = 86_400_000;
/// The Mac's day of a moment, with the offset in force then.
export const localDay = (atMs: number) => Math.floor((atMs - new Date(atMs).getTimezoneOffset() * 60_000) / DAY);
/// A local day number as a date; the number already holds the time zone, so it is read as UTC.
export const dateOf = (day: number, options: Intl.DateTimeFormatOptions) => new Date(day * DAY).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
/// A list's heading for a day: Today, Yesterday, or its date, with the year when it is not this one.
export function dayTitle(day: number, today: number) {
  if (day === today) return 'Today';
  if (day === today - 1) return 'Yesterday';
  const thisYear = dateOf(day, { year: 'numeric' }) === dateOf(today, { year: 'numeric' });
  return dateOf(day, { weekday: 'long', month: 'long', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}
/// A notes list's group for a day, as Apple Notes groups them: Today, Yesterday, the previous week, the previous
/// month, then by month (with the year when it isn't this one). Fewer, wider groups than one per day.
export function listGroup(day: number, today: number) {
  if (day >= today) return 'Today';
  if (day === today - 1) return 'Yesterday';
  if (day >= today - 7) return 'Previous 7 days';
  if (day >= today - 30) return 'Previous 30 days';
  const thisYear = dateOf(day, { year: 'numeric' }) === dateOf(today, { year: 'numeric' });
  return dateOf(day, { month: 'long', ...(thisYear ? {} : { year: 'numeric' }) });
}
/// When a row in that list was changed, as short as the group allows: the time today, "Yesterday", the weekday
/// this week, else the date.
export function listWhen(atMs: number, today: number) {
  const day = localDay(atMs);
  if (day >= today) return new Date(atMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (day === today - 1) return 'Yesterday';
  if (day >= today - 7) return dateOf(day, { weekday: 'long' });
  const thisYear = dateOf(day, { year: 'numeric' }) === dateOf(today, { year: 'numeric' });
  return dateOf(day, { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) });
}
/// The local "YYYY-MM-DD HH.mm", as a note's stamp is written.
export const stamp = (now = new Date()) => {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}`;
};
/// "Today at 2:05 PM", "Yesterday at 9:30 AM", or the date and time, by calendar days from `now`.
export function meetingWhen(ms: number, now: number) {
  const at = new Date(ms), today = new Date(now);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(at.toDateString()).getTime()) / 86_400_000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day} at ${time}`;
}
/// "Under a minute", "23 min", "1 h 5 min".
export function meetingLength(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'Under a minute';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
/// A meeting's stopwatch since `since`: m:ss, with hours as h:mm:ss.
export const elapsed = (since: number, now: number) => {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
};
/// A note's clock since `start` (0 for not started): m:ss, minutes running past 59.
export const noteClock = (start: number, now: number) => {
  const seconds = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
