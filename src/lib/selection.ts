export type Picked = { ids: Set<string>; anchor: string | null };

/// The selection after a click on `id`, as Finder and Business's lists have it: ⌘ adds or takes away one, ⇧ adds
/// everything from the last one clicked to this one (in `order`, the list as shown), and a plain click picks nothing.
export function nextPicked({ ids, anchor }: Picked, order: readonly string[], id: string, cmd: boolean, shift: boolean): Picked {
  if (shift && anchor !== null && order.includes(anchor)) {
    const [from, to] = [order.indexOf(anchor), order.indexOf(id)].sort((a, b) => a - b);
    return { ids: new Set([...ids, ...order.slice(from, to + 1)]), anchor };
  }
  if (!cmd && !shift) return { ids: new Set(), anchor: id };
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return { ids: next, anchor: id };
}
