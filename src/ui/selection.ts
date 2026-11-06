import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { nextPicked, type Picked } from '../lib/selection';

/// Many picked at once from a list, for doing one thing to all of them. `click` takes a row's click and says whether
/// it only changed the selection (⌘ or ⇧ held), so the row does nothing else; a plain click clears it and the row
/// opens as usual. `keys` goes on the list: ⌘A picks every row, Escape lets them all go. Rows that leave the list
/// leave the selection.
export function useSelection(order: readonly string[]) {
  const [state, setState] = useState<Picked>({ ids: new Set(), anchor: null });
  const ids = useMemo(() => new Set([...state.ids].filter(id => order.includes(id))), [state.ids, order]);
  const clear = () => setState(now => now.ids.size ? { ids: new Set(), anchor: now.anchor } : now);
  return {
    ids,
    clear,
    click: (id: string, event: MouseEvent) => {
      const cmd = event.metaKey || event.ctrlKey, shift = event.shiftKey;
      setState(now => nextPicked(now, order, id, cmd, shift));
      return cmd || shift;
    },
    keys: (event: KeyboardEvent) => {
      if (event.key === 'a' && (event.metaKey || event.ctrlKey) && order.length) { event.preventDefault(); setState({ ids: new Set(order), anchor: null }); }
      else if (event.key === 'Escape' && state.ids.size) { event.preventDefault(); clear(); }
    },
  };
}
