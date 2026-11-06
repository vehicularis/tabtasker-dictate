/// Plain text that is written as Markdown: a heading, a list, a fenced block, bold or a link on one of its lines.
export const looksLikeMarkdown = (text: string) => /^(?:#{1,6} |[-*+] |\d+\. |> |```)/m.test(text) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(text);
