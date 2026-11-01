// Split one todo step into prose and command parts so the card can show each
// command as its own code block with a Copy button.
export type Part = { kind: 'prose' | 'cmd'; text: string }

const CMD_WORDS = 'sudo|scp|ssh|git|npm|npx|node|cd|rooms|curl|wget|ls|cat|mkdir|rm|cp|mv|chmod|chown|docker|gh|brew|systemctl|launchctl|tmux|export|echo|cargo|pip3?|python3?|make|sh|bash|kill|tail|nohup|source|open|apt|apt-get|tar|rsync'
const START = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=\\S+|(?:\\./|~/|/)\\S+|(?:${CMD_WORDS})(?=\\s|$))`)

function push(parts: Part[], kind: Part['kind'], text: string) {
  text = text.trim()
  if (text) parts.push({ kind, text })
}

// Where an unfenced command stops: a dash aside, "; then", or a new sentence.
function endOf(s: string): number {
  const stops = [s.search(/\s[—–]\s/), s.search(/;\s+(?:then|and then)\b/), s.search(/\.\s+(?=[A-Z][a-z])/)].filter(i => i >= 0)
  return stops.length ? Math.min(...stops) : s.length
}

function heuristic(text: string): Part[] {
  const parts: Part[] = []
  let rest = text
  for (;;) {
    let found = -1
    for (const m of rest.matchAll(/(?::\s+|^)(?=\S)/g)) {
      const at = m.index! + m[0].length
      if (START.test(rest.slice(at))) { found = at; break }
    }
    if (found < 0) break
    push(parts, 'prose', rest.slice(0, found))
    const tail = rest.slice(found)
    const end = endOf(tail)
    push(parts, 'cmd', tail.slice(0, end).replace(/[.,]$/, ''))
    rest = tail.slice(end).replace(/^[.;,]\s*/, '')
  }
  push(parts, 'prose', rest)
  return parts
}

export function stepParts(text: string): Part[] {
  const fenced = text.match(/```[a-z]*\n?([\s\S]*?)```/)
  if (fenced || text.includes('`')) {
    const parts: Part[] = []
    let rest = text
    for (;;) {
      const m = rest.match(/```[a-z]*\n?([\s\S]*?)```|`([^`]+)`/)
      if (!m) break
      push(parts, 'prose', rest.slice(0, m.index))
      for (const line of (m[1] ?? m[2]).split('\n')) push(parts, 'cmd', line)
      rest = rest.slice(m.index! + m[0].length)
    }
    push(parts, 'prose', rest)
    return parts
  }
  return heuristic(text)
}
