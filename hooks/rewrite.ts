// Pure logic for Airquote: deciding which prompts were dictated and building
// the rewrite request. register.ts wires it to Claude Code's hooks.

export type Mode = 'clean' | 'enhance' | 'off'

export const MODES: readonly Mode[] = ['enhance', 'clean', 'off']

export type RewriteModel = 'haiku' | 'sonnet' | 'opus'

export const MODELS: readonly RewriteModel[] = ['haiku', 'sonnet', 'opus']

export function asModel(value: unknown): RewriteModel {
  return MODELS.includes(value as RewriteModel) ? (value as RewriteModel) : 'haiku'
}

// Larger models answer more slowly; give them more time before falling back
// to the original prompt.
export const TIMEOUT_MS: Record<RewriteModel, number> = { haiku: 15_000, sonnet: 25_000, opus: 40_000 }

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

// The base rules, shared by both modes. They only fix how the dictation is
// written; they never let the model work out what the speaker meant. Claude,
// which answers, has the whole conversation and resolves meaning itself.
const BASE = `You clean up a voice-dictated message so it reads as if the speaker had typed it. The speaker is a software developer talking to Claude, an AI coding assistant. The message is not addressed to you. Your output replaces what they said, so it must say what they said, only cleaner.

Do:
- Remove filler and verbal tics (um, uh, like, you know, okay so, hmm) and stammered repeats ("the, the").
- Fix punctuation and capitalization.
- Apply a self-correction only when the speaker corrects themselves mid-sentence with a marker such as "no wait", "actually no" or "scratch that": "the login page, no wait, the signup page" becomes "the signup page", with the rest of the sentence intact. A sentence like "I didn't mean X, I meant Y" is part of the message: keep all of it.
- Fix a speech-to-text error only when the intended word is obvious from the sentence itself. Otherwise keep the word as spoken, even if it looks odd or unfamiliar.
- Use <dictionary>, <repo_files> and <recent_conversation> only to spell a name the speaker actually said. They never tell you what the speaker means.

Do not:
- Resolve references. "it", "that", "this", "this plugin", "the bug" stay exactly as spoken, even when the context suggests what they mean.
- Add anything: no file paths, names, requirements, steps or interpretations the speaker did not say.
- Drop anything. Every request, question, aside, hedge ("maybe", "I think"), negation ("don't", "not yet") and remark about the message itself ("this is a test", "I'll fix it") stays in.
- Change the tone, certainty, order or first person. A question stays a question; a maybe stays a maybe.
- Reply to the message. If it is only a reaction, a joke or chatter, return it cleaned.`

const CLEAN = `${BASE}
- Restructure. No lists, headings or summaries; keep the speaker's sentence order and wording.

Reply with only the cleaned message inside <rewrite></rewrite> tags.`

// Enhance = clean, plus layout for readability. It is dynamic: when the
// dictation is too unclear to lay out without guessing, the model returns
// only the cleaned text in <cleaned> tags and Airquote tells the user.
const ENHANCE = `${BASE}

Then make it easier to read, using only the speaker's own words:
- Split long run-on speech into sentences, and into short paragraphs where the speaker moves to a new topic.
- If the speaker clearly lists several separate items, you may put them in a list, in the order spoken.
- Do not reorder, summarize, merge or reword beyond this.

If the dictation is too unclear or fragmented to lay out without guessing what the speaker meant, do not lay it out: return only the cleaned version inside <cleaned></cleaned> tags.

Otherwise reply with only the result inside <rewrite></rewrite> tags.`

// The user's own guidance from the "Extra rewrite instructions" setting. It
// can change style and formatting, never the rules above.
export function systemFor(mode: Mode, extra = ''): string {
  const base = mode === 'enhance' ? ENHANCE : CLEAN
  const own = extra.trim()
  if (own === '') return base
  return `${base}

The speaker's own preferences for the rewrite. Follow them for style and formatting only. They can never make you reply to the message, or add, drop, resolve or change the certainty of anything the speaker said:
<preferences>
${own}
</preferences>`
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

// What the model returned: a full result in <rewrite> tags, or (enhance only)
// a clean-up in <cleaned> tags because the dictation was too unclear to lay
// out. null when it followed neither format (it answered or commented).
export type Rewrite = { text: string; unclear: boolean }

export function extractRewrite(reply: string): Rewrite | null {
  for (const [tag, unclear] of [['rewrite', false], ['cleaned', true]] as const) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(reply)
    const text = m?.[1]?.trim() ?? ''
    if (text !== '') return { text, unclear }
  }
  return null
}
