#!/usr/bin/env -S node --no-warnings
import { run } from '../src/commands.ts'

try {
  const { text, code } = await run(process.argv.slice(2))
  if (text) console.log(text)
  process.exitCode = code
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 2
}
