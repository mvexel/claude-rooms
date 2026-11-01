import { createHash } from 'node:crypto'

// An agent's name and avatar, derived from its session id alone: nothing is
// stored or wired at spawn time, and the same session always looks the same.

const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Dusty', 'Eager', 'Fern', 'Gentle', 'Hazel', 'Ivory', 'Jolly', 'Keen', 'Lucky', 'Mellow', 'Nimble', 'Olive', 'Plucky', 'Quiet', 'Rusty', 'Sunny', 'Tidy', 'Umber', 'Vivid', 'Witty', 'Zesty']
const NOUNS = ['Heron', 'Otter', 'Badger', 'Finch', 'Lynx', 'Marten', 'Newt', 'Osprey', 'Panda', 'Quail', 'Robin', 'Stoat', 'Tern', 'Vole', 'Wren', 'Yak', 'Ibis', 'Gecko', 'Hare', 'Kiwi', 'Moth', 'Pika', 'Seal', 'Toad']

export type Identity = { name: string; hue: number; svg: string }

const bytes = (session: string) => createHash('sha256').update(session.trim().toLowerCase()).digest()

export function identity(session: string): Identity {
  const b = bytes(session)
  const name = `${ADJECTIVES[b[0] % ADJECTIVES.length]} ${NOUNS[b[1] % NOUNS.length]}`
  const hue = ((b[2] << 8) | b[3]) % 360
  // 5x5 grid, mirrored left to right: columns 0-2 decide, 3-4 copy 1-0.
  const cells: string[] = []
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if (b[4 + y * 3 + x] & 1) {
        for (const cx of x === 2 ? [2] : [x, 4 - x]) cells.push(`<rect x="${cx}" y="${y}" width="1" height="1"/>`)
      }
  // Lightness comes from --av-l (30% light theme default, 62% in the dark theme) so every hue clears 3:1.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 7 7" role="img" aria-label="Avatar of ${name}" width="32" height="32">` +
    `<rect x="-1" y="-1" width="7" height="7" rx="1.5" fill="hsl(${hue} 55% 50% / 0.22)"/>` +
    `<g style="fill:hsl(${hue} 65% var(--av-l,30%));stroke:hsl(${hue} 65% var(--av-l,30%))" stroke-width="0.02">${cells.join('')}</g></svg>`
  return { name, hue, svg }
}
