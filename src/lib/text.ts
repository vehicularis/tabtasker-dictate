/// The words a search is made of, lower-cased by the Mac's language; they are also the words a list marks.
export const searchWords = (query: string) => query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
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
