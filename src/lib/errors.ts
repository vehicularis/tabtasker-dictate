/// What went wrong, in words: the native side's own when it sent some (a string), else `fallback`.
export const message = (error: unknown, fallback: string) => typeof error === 'string' ? error : fallback;
