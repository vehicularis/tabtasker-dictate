/// Plain text that is written as Markdown: a heading, a list, a fenced block, a table (a pipe row over its dashed
/// separator row), or bold or a link on one of its lines.
export const looksLikeMarkdown = (text: string) => /^(?:#{1,6} |[-*+] |\d+\. |> |```)/m.test(text) || /\*\*[^*\n]*[^*\s][^*\n]*\*\*|\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  || /^ *\|.+\|[ \t]*\r?\n *\|?[ :]*-{3,}[-| :]*$/m.test(text);
