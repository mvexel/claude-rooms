// Split one todo step into prose and command parts so the card can show each
// command as its own code block with a Copy button.
export type Part = { kind: 'prose' | 'cmd' | 'code'; text: string }

const SURE = 'sudo|scp|ssh|git|npm|npx|node|cd|curl|wget|ls|mkdir|rm|cp|mv|chmod|chown|docker|gh|brew|systemctl|launchctl|tmux|cargo|pip3?|python3?|nohup|apt|apt-get|tar|rsync'
// English words too: only a command when an argument that looks like one follows.
const MAYBE = 'make|open|source|kill|tail|cat|echo|export|sh|bash|rooms'
const ARG = '(?:-|[./~$]|[A-Za-z_][A-Za-z0-9_]*=|https?:|(?:ask|log|done|serve|init|brief|answer|withdraw|need|status|spawn|show)\\b)'
const START = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_]*=\\S+|(?:\\./|~/|/)\\S+|(?:${SURE})(?=\\s|$)|(?:${MAYBE})\\s+(?=${ARG}))`)

function push(parts: Part[], kind: Part['kind'], text: string, raw = false) {
  if (!raw) text = text.trim()
  if (text.trim()) parts.push({ kind, text })
}

// Where an unfenced command stops: a dash aside, "; then", or a new sentence,
// never inside quotes or $( ).
function endOf(s: string): number {
  let q = '', depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === q) q = ''; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (!depth) {
      const r = s.slice(i)
      if (/^\s[—–]\s/.test(r) || /^;\s+(?:and )?then\b/.test(r) || /^\.\s+(?=[A-Z][a-z])/.test(r)) return i
    }
  }
  return s.length
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
    // a "." or "," glued to a word is sentence punctuation; a lone "." is an argument
    push(parts, 'cmd', tail.slice(0, end).replace(/(?<=[\w/)"'\]])[.,]$/, ''))
    rest = tail.slice(end).replace(/^[.;,]\s*/, '')
  }
  push(parts, 'prose', rest)
  return parts
}

const looksLikeCommand = (t: string) => /\s/.test(t.trim()) || START.test(t.trim())

// Lines ending in a backslash continue on the next one.
function lines(block: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const l of block.split('\n')) {
    cur = cur ? cur + '\n' + l : l
    if (!/\\\s*$/.test(l)) { out.push(cur); cur = '' }
  }
  if (cur) out.push(cur)
  return out
}

export function stepParts(text: string): Part[] {
  if (!text.includes('`')) return heuristic(text)
  const parts: Part[] = []
  let rest = text
  for (;;) {
    const m = rest.match(/```[a-z]*\n?([\s\S]*?)```|`([^`]+)`/)
    if (!m) break
    push(parts, 'prose', rest.slice(0, m.index), true)
    if (m[1] !== undefined) for (const l of lines(m[1])) push(parts, 'cmd', l)
    else push(parts, looksLikeCommand(m[2]) ? 'cmd' : 'code', m[2])
    rest = rest.slice(m.index! + m[0].length)
  }
  push(parts, 'prose', rest, true)
  return parts
}
