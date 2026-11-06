/// `notes//Users/you/Documents/TabTasker Dictate/Hello.md` is the place `notes` with that path.
export const split = (route: string): [string, string | null] => {
  const slash = route.indexOf('/');
  return slash < 0 ? [route, null] : [route.slice(0, slash), route.slice(slash + 1) || null];
};

/// A note's title from its path: the file name without `.md` and without its date stamp. Empty when nothing is left.
export const noteTitle = (path: string): string => (path.split('/').pop() ?? '').replace(/\.md$/, '').replace(/^\d{4}-\d\d-\d\d( \d\d\.\d\d)? ?/, '');

/// The route a `location.hash` asks for: decoded, or `notes` when it is empty.
export const routeOf = (hash: string): string => decodeURIComponent(hash.slice(1)) || 'notes';
