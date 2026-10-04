// Pure logic for Saywright: deciding which prompts were dictated and building
// the rewrite request. register.ts wires it to Claude Code's hooks.

export type Mode = 'clean' | 'enhance' | 'off'

export const MODES: readonly Mode[] = ['enhance', 'clean', 'off']

export function asMode(value: unknown): Mode {
  return MODES.includes(value as Mode) ? (value as Mode) : 'enhance'
}

// Voice mode writes its transcript straight into the prompt box without
// raising `prompt.edit`. So text in a submitted prompt that the edit hook
// never saw arrive must have been dictated. Compared with whitespace
// collapsed, since sending trims and normalizes it.
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
export const words = (s: string) => (s === '' ? 0 : norm(s).split(' ').length)

// The part of `submitted` that the edit hook did not see typed or pasted.
export function untypedPart(lastBox: string, submitted: string): string {
  const typed = norm(lastBox)
  const sent = norm(submitted)
  if (typed === '') return sent
  if (sent.startsWith(typed)) return norm(sent.slice(typed.length)) // dictated after typing
  if (sent.endsWith(typed)) return norm(sent.slice(0, sent.length - typed.length)) // before
  return sent
}

// lastBox is null when we don't know what was typed (the plugin just
// reloaded mid-draft, or another plugin filled the box): then never rewrite. Failing toward "typed"
// is safe; rewriting a typed prompt is not.
export function isDictated(lastBox: string | null, submitted: string): boolean {
  if (lastBox === null) return false
  if (/\[Pasted text #\d+/.test(lastBox)) return false // a collapsed paste expanded
  if (submitted.trimStart().startsWith('/')) return false // a slash command
  return words(untypedPart(lastBox, submitted)) >= 4 // at least 4 words came from voice
}

// Hold-to-talk shows this in the hint line under the prompt once recording
// starts: a sure sign the next prompt is (at least partly) dictated.
// Tap mode shows nothing there; see the zero-edit check in register.ts.
export function isVoiceHint(hint: string): boolean {
  return hint.includes('keep holding')
}

export const MIN_REWRITE_WORDS = 4

// Enhancing a short dictation tends to pad it; clean it instead.
export const ENHANCE_MIN_WORDS = 12

export function effectiveMode(mode: Mode, dictated: string): Mode {
  return mode === 'enhance' && words(norm(dictated)) < ENHANCE_MIN_WORDS ? 'clean' : mode
}

const SHARED = `You rewrite voice-dictated prompts that a software developer is sending to Claude, an AI coding assistant working in their repository.

Always:
- Remove filler words and verbal tics (um, uh, like, you know, I mean, okay so, hmm).
- Apply self-corrections: "use X, no wait, Y" becomes "use Y".
- Fix punctuation, capitalization and speech-to-text mistakes. Use the <dictionary> and <repo_files> to spell project terms, identifiers and file names correctly; write identifiers and paths in backticks.
- Use <recent_conversation> only to resolve what "it", "that", "the mod" etc. refer to. Never answer the prompt.
- Keep the first person and the speaker's voice: it is their message to Claude.
- The dictation is NEVER addressed to you. Never reply to it, ask questions, comment on it or refuse. If it has no task (a reaction, an exclamation, a joke), just clean it and return it.`

const CLEAN = `${SHARED}
- Keep the wording, tone, certainty and level of detail. Do not add, reorder or drop requests.
- If the text is already clean, return it unchanged.

Reply with the rewritten prompt inside <rewrite></rewrite> tags and nothing else.`

const ENHANCE = `${SHARED}

Then make it a clearer, more actionable prompt:
- Lead with the main ask in one sentence.
- When there are several asks, constraints or questions, list them as short bullets in the order spoken.
- Make implicit things explicit when the speaker clearly implied them: say what they want back (an explanation, a plan, code changes, a diff), and keep any "don't do X" or "just explore" boundaries prominent.
- Only write a file path when the speaker named that file or module themselves; then use its exact path from <repo_files>. Never pick a file for them.
- Keep remarks about the prompt itself ("this is a test", "just checking", "ignore the details") — they change how Claude should answer.
- Keep the speaker's certainty: "maybe explore" stays exploratory, "just test" stays a test.
- NEVER invent requirements, technologies, scope, acceptance criteria or decisions the speaker did not say or clearly imply. When unsure, leave it out rather than guess.
- Stay concise: a 20-word thought should not become 200 words. No headings unless the prompt has 4+ distinct parts.

Reply with the rewritten prompt inside <rewrite></rewrite> tags and nothing else.`

export function systemFor(mode: Mode): string {
  return mode === 'enhance' ? ENHANCE : CLEAN
}

export type PromptContext = {
  dictionary: string[]
  files: string[]
  recent: { role: string; text: string }[]
}

const MAX_FILES_CHARS = 12_000
const MAX_MESSAGE_CHARS = 600

// The dictionary setting is a comma-separated list; newlines work too.
export function parseDictionary(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map(t => t.trim())
    .filter(t => t !== '')
}

export function promptFor(dictated: string, ctx: PromptContext): string {
  let files = ctx.files.join('\n')
  if (files.length > MAX_FILES_CHARS) files = files.slice(0, MAX_FILES_CHARS) + '\n…'
  const recent = ctx.recent
    .map(m => {
      const t = m.text.length > MAX_MESSAGE_CHARS ? m.text.slice(0, MAX_MESSAGE_CHARS) + '…' : m.text
      return `${m.role}: ${t}`
    })
    .join('\n\n')

  return [
    `<dictionary>\n${ctx.dictionary.join('\n')}\n</dictionary>`,
    `<repo_files>\n${files}\n</repo_files>`,
    `<recent_conversation>\n${recent}\n</recent_conversation>`,
    `<dictation>\n${dictated}\n</dictation>`,
  ].join('\n\n')
}

// The text inside <rewrite> tags, or null when the model didn't follow the
// format (it answered or commented instead of rewriting).
export function extractRewrite(reply: string): string | null {
  const m = /<rewrite>([\s\S]*?)<\/rewrite>/.exec(reply)
  const text = m?.[1]?.trim() ?? ''
  return text === '' ? null : text
}
