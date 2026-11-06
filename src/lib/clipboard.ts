/// Puts text on the clipboard; rejects when neither the async clipboard nor the selection way works.
export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* a web view without the async clipboard */ }
  const area = Object.assign(document.createElement('textarea'), { value: text });
  area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('copy');
}
