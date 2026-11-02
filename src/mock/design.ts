import type { Mock } from '.';

// In a browser: the overlay's look and the About page. `?size=`, `?idle=`, `?hint=off` and `?key=` start
// the overlay previews with that Appearance and dictate key, as if chosen in Settings.
export function register(mock: Mock) {
  const params = new URLSearchParams(location.search);
  const size = params.get('size'), idle = params.get('idle'), hint = params.get('hint'), key = params.get('key');
  mock.update({
    appearance: { ...(size && { size }), ...(idle && { idle }), ...(hint && { hint: hint !== 'off' }) },
    ...(key && { shortcuts: { dictate: key } }),
  });
}
