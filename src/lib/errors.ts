/// What went wrong, in words: the native side's own when it sent some (a string), else `fallback`.
export const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
/// The text with a full stop, unless it already ends a sentence.
export const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
