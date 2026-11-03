// The notes and meetings folders, as the window's lists know them.

/// The lists open now: each one reads the folder again when asked (useLibrary adds itself).
export const readers = new Set<() => void>();
/// Every open list reads the folder again, after a change none of them would notice by itself: many archived at
/// once, or a note left empty and put in the Trash.
export const refreshLibrary = () => readers.forEach(read => read());
/// A note still under the name it was made with (nothing, or a date and "Note" or "Meeting", maybe a number):
/// the list calls it "New note", and one left like that with nothing in it goes to the Trash (NoteEditor).
export const isUnnamed = (title: string) => !title.trim() || /^\d{4}-\d{2}-\d{2}(?: \d{1,2}\.\d{2})? (?:Note|Meeting)(?: \d+)?$/.test(title.trim());
