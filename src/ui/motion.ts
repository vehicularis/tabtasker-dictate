import { useLayoutEffect, useRef, type RefObject } from 'react';

// Motion for what CSS cannot do on its own: a list that changes under you (useFlip) and a thing that goes away
// (leave). The curves and durations are the tokens' own (tokens.css), read off the page, so a glide in script and
// a glide in CSS are one glide. Under reduced motion nothing moves and the fades stay, as in CSS.

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
/// A duration and a curve from the tokens: `--ease` over `--slow` unless named.
export const timing = (duration = '--slow', easing = '--ease'): KeyframeAnimationOptions => ({ duration: parseFloat(token(duration)) || 0, easing: token(easing) || 'ease' });

/// `el` fading out where it stood, as a copy in `into`: React has taken it out, or is about to. It goes the way
/// its CSS says (`--leave`, a transform; a slight shrink toward its transform-origin if none), over --quick on
/// --ease-in, and takes no clicks while it goes.
function fadeOut(el: HTMLElement, box: DOMRect, into: Element) {
  const width = el.offsetWidth || box.width, height = el.offsetHeight || box.height;
  if (!width || !height) return;
  const copy = el.cloneNode(true) as HTMLElement;
  for (const name of ['data-flip', 'data-hit', 'id', 'role']) copy.removeAttribute(name);
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.dataset.leaving = '';
  Object.assign(copy.style, { position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto', margin: '0', width: `${width}px`, height: `${height}px`,
    boxSizing: 'border-box', transform: 'none', translate: 'none', scale: 'none', pointerEvents: 'none' });
  into.append(copy);
  // A copy starts scrolled to the top: a list scrolled down would flash its first rows as it went.
  const scrolled = [el, ...el.querySelectorAll('*')], copied = [copy, ...copy.querySelectorAll('*')];
  scrolled.forEach((node, i) => { if (node.scrollTop || node.scrollLeft) Object.assign(copied[i], { scrollTop: node.scrollTop, scrollLeft: node.scrollLeft }); });
  // Placed at its containing block's corner first, so the offset to where it stood is known whatever that block is.
  const corner = copy.getBoundingClientRect();
  copy.style.left = `${box.left - corner.left}px`;
  copy.style.top = `${box.top - corner.top}px`;
  // Once React has taken the original out, its parent may have moved (the dock shrinks round what is left): put
  // the copy back where the original stood. Its fade has not begun to move it yet.
  queueMicrotask(() => {
    const at = copy.getBoundingClientRect();
    copy.style.left = `${parseFloat(copy.style.left) + box.left - at.left}px`;
    copy.style.top = `${parseFloat(copy.style.top) + box.top - at.top}px`;
  });
  const style = getComputedStyle(copy);
  const to = reduced() ? 'none' : style.getPropertyValue('--leave').trim() || 'scale(.96)';
  const options = timing('--quick', '--ease-in');
  const gone = () => copy.remove();
  copy.animate([{ opacity: style.opacity, transform: 'none' }, { opacity: 0, transform: to }], { ...options, fill: 'forwards' }).finished.then(gone, gone);
  setTimeout(gone, Number(options.duration) + 200); // a hidden window runs no frames
}

/// A ref for something that should go rather than vanish: a toast, a menu, a card by the dots, the column. React
/// lets go of a ref while the element is still on the page, so it is copied there and the copy fades.
export const leave = (el: HTMLElement | null) => el ? () => { if (el.isConnected && el.parentElement) fadeOut(el, el.getBoundingClientRect(), el.parentElement); } : undefined;

type Seen = Map<string, { el: HTMLElement; box: DOMRect }>;
const look = (root: HTMLElement | null): Seen => new Map([...(root?.querySelectorAll<HTMLElement>('[data-flip]') ?? [])].map(el => [el.dataset.flip!, { el, box: el.getBoundingClientRect() }]));

/// A list that changes under you (a sticky closed, a tab opened, a note added) moves instead of jumping: every
/// keyed part of `root` (`data-flip`) glides from where it was to where it is now, a new one fades in (as its CSS
/// `--enter` says, a slight grow if it says nothing), a gone one fades out where it stood. Where everything was is
/// read while rendering for a new `change`, when the page still shows the old list, and the glide starts once the
/// new one is laid out. Interrupted, a glide starts again from where the part is on the screen. The first list
/// (nothing seen before it) just appears.
export function useFlip(root: RefObject<HTMLElement | null>, change: unknown) {
  const last = useRef(change), before = useRef<Seen | null>(null);
  if (last.current !== change) { last.current = change; before.current = look(root.current); } // ponytail: getSnapshotBeforeUpdate, as a hook
  useLayoutEffect(() => {
    const was = before.current, el = root.current;
    before.current = null;
    if (el && was?.size) play(el, was);
  }, [change, root]);
}

function play(root: HTMLElement, was: Seen) {
  const parts = [...root.querySelectorAll<HTMLElement>('[data-flip]')];
  for (const part of parts) for (const running of part.getAnimations()) if (running.id === 'flip') running.cancel();
  const still = reduced(), glide = timing(), fade = timing('--quick');
  const here = new Set<string>();
  for (const part of parts) {
    const key = part.dataset.flip!, from = was.get(key)?.box, to = part.getBoundingClientRect();
    here.add(key);
    if (!from) {
      part.animate({ opacity: [0, 1] }, { ...fade, id: 'flip-fade' }); // not cancelled by a glide that interrupts it
      const enter = getComputedStyle(part).getPropertyValue('--enter').trim() || 'scale(.96)';
      if (!still && enter !== 'none') part.animate({ transform: [enter, 'none'] }, { ...glide, id: 'flip' });
      continue;
    }
    const dx = from.left - to.left, dy = from.top - to.top;
    if (!still && Math.abs(dx) + Math.abs(dy) >= 1) part.animate({ transform: [`translate(${dx}px, ${dy}px)`, 'none'] }, { ...glide, id: 'flip' });
  }
  for (const [key, { el, box }] of was) if (!here.has(key) && !el.isConnected) fadeOut(el, box, root);
}
