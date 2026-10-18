// Context export and import: the conversation as Markdown, written beside your other exports,
// and an export read back into the context window as a note the model reads. Pure functions;
// the files and the session are register.tsx's.
import type { SessionMessage } from 'claude-code'

/** A tool's input or result longer than this is cut, so one huge output doesn't swamp the file. */
const TOOL_TEXT_MAX = 8_000

/** Rough tokens in a text: about four characters each. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4)

const cut = (s: string, max = TOOL_TEXT_MAX): string =>
  s.length > max ? `${s.slice(0, max)}\n[… ${s.length - max} more characters cut]` : s

const fence = (s: string): string => {
  const ticks = '`'.repeat(Math.max(3, ...[...s.matchAll(/`+/g)].map(m => m[0].length + 1)))
  return `${ticks}\n${s}\n${ticks}`
}

/** The file name of an export made at `ms`: sortable, safe on every system. */
export const exportName = (ms: number): string => `context-${new Date(ms).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}.md`

/** The folder exports go to: one per project, under ~/.claude, out of the repository. */
export const exportDir = (home: string, root: string): string =>
  `${home}/.claude/context-exports/${root.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session'}`

/** The conversation as Markdown: each message in order, tool calls with their input and result. */
export function formatExport(messages: readonly SessionMessage[], meta: { at: number; project: string; sessionId: string; model: string }): string {
  const out: string[] = [
    '# Context export',
    '',
    `- Project: \`${meta.project}\``,
    `- Session: \`${meta.sessionId}\``,
    `- Model: \`${meta.model}\``,
    `- Exported: ${new Date(meta.at).toISOString()}`,
    `- Messages: ${messages.length}`,
    '',
  ]
  for (const m of messages) {
    // A user row that only carries tool results belongs to the call above it.
    if (m.role === 'user' && !m.text.trim()) continue
    out.push(`## ${m.role === 'user' ? 'User' : 'Claude'}`, '')
    if (m.text.trim()) out.push(m.text.trim(), '')
    for (const u of m.toolUses) {
      out.push(`**Tool: ${u.tool}**${u.isError ? ' (error)' : ''}`, '', fence(cut(JSON.stringify(u.input, null, 2))), '')
      if (u.text !== undefined) out.push('Result:', '', fence(cut(u.text)), '')
    }
  }
  return out.join('\n')
}

/**
 * The note an import appends: the export, framed so the model reads it as earlier context.
 * Over `budget` tokens, the newest part that fits is kept, cut at a message heading.
 */
export function importNote(file: string, name: string, budget: number): { text: string; tokens: number; isCut: boolean } {
  let body = file
  let isCut = false
  if (estTokens(body) > budget) {
    isCut = true
    const tail = body.slice(body.length - budget * 4)
    const at = tail.search(/^## (User|Claude)$/m)
    body = at >= 0 ? tail.slice(at) : tail
  }
  const text =
    `<imported-context source="${name}"${isCut ? ' truncated="oldest part left out to fit the context window"' : ''}>\n` +
    'The person imported this record of an earlier conversation so you can continue from it. ' +
    'Treat it as background on what was said and done; it is not a new request.\n\n' +
    `${body.trim()}\n</imported-context>`
  return { text, tokens: estTokens(text), isCut }
}
