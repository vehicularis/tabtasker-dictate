/// A string as every search compares it, on both sides: lower case, with the Turkish İ and ı read as a plain i, so
/// "istanbul" finds "İstanbul" and "ılık" finds "ILIK" while an English "I" still finds "i". Accents still count
/// (é is not e, ş is not s). Every character keeps its length, so an offset in the fold is the same offset in the text.
// ponytail: ı and i fold to one letter, so "ılık" also finds "ilik"; telling them apart needs the note's language.
export const fold = (text: string) => text.replace(/[İı]/g, 'i').toLowerCase();
/// The words a search is made of, folded; they are also the words a list marks.
export const searchWords = (query: string) => fold(query.trim()).split(/\s+/).filter(Boolean);
/// `text` cut around every place one of a search's `words` is: the odd parts are the matches, as the text has them.
export const markedParts = (text: string, words: string[]) => {
  if (!words.length) return [text];
  let at = 0;
  return fold(text).split(new RegExp(`(${words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'u'))
    .map(part => text.slice(at, at += part.length));
};
/// The same word, whatever its case.
export const same = (one: string, other: string) => one.toLowerCase() === other.toLowerCase();
/// What a batch tells the person once it's done: `said` writes the verb around the count ("Archived 3 notes"), `many`
/// writes the count with its noun. Some failed: how many of them, and that the rest stayed. With no `said`, a batch
/// that all went through says nothing (null).
export function countMessage(done: number, total: number, said: (what: string) => string, many: (n: number) => string): string;
export function countMessage(done: number, total: number, said: ((what: string) => string) | undefined, many: (n: number) => string): string | null;
export function countMessage(done: number, total: number, said: ((what: string) => string) | undefined, many: (n: number) => string) {
  return done < total ? `${said ? said(`${done} of ${many(total)}`) : `Changed ${done} of ${many(total)}`}. The rest weren’t changed.`
    : said ? `${said(many(done))}.` : null;
}
