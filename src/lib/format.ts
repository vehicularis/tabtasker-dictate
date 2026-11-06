// Numbers and lengths as the app words them.
/// "1 word", "2 words": `many` is `one` and an s unless given.
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
/// A length of time as whole minutes, or hours and the minutes left over.
export function duration(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: minutes.toLocaleString(), unit: 'min' };
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return { value: hours.toLocaleString(), unit: rest ? `h ${rest} min` : 'h' };
}
/// A download size: whole MB, or GB with one decimal from a billion bytes.
export const megabytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
/// A fraction as a whole percent.
export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
/// Milliseconds as seconds with one decimal.
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
