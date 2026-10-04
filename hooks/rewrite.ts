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
export const words = (s: string) => (norm(s) === '' ? 0 : norm(s).split(' ').length)

// What changed between two drafts: the span of `after` that isn't in
// `before`. Used to catch dictation that landed between two edits.
export function inserted(before: string, after: string): string {
  let p = 0
  while (p < before.length && p < after.length && before[p] === after[p]) p++
  let q = 0
  while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++
  return after.slice(p, after.length - q)
}

// The part of `submitted` that the edit hook did not see typed or pasted.
export function untypedPart(lastBox: string, submitted: string): string {
  const typed = norm(lastBox)
  const sent = norm(submitted)
  if (typed === '') return sent
  if (sent.startsWith(typed)) return norm(sent.slice(typed.length)) // dictated after typing
  if (sent.endsWith(typed)) return norm(sent.slice(0, sent.length - typed.length)) // before
  return sent
}

// Text in a submitted prompt that the person did not say: a paste Claude Code
// expanded into <pasted_content> tags, a <system-reminder> a host put in
// front, and things only a keyboard writes (code in backticks, an @file
// mention, an [Image #N] or [Pasted text #N] placeholder). Detection never
// counts it and the rewrite model never sees it; it goes back into the
// rewrite unchanged.
const KEPT = new RegExp(
  [
    String.raw`<(pasted_content|system-reminder)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>`,
    '```[\\s\\S]*?```',
    '`[^`\\n]+`',
    String.raw`\[(?:Image|Pasted text) #\d+[^\]]*\]`,
    String.raw`(?<![\w@])@[\w./~-]+`,
  ].join('|'),
  'g',
)
const MARKER = /\[kept block (\d+)\]/g

export const withoutKept = (s: string) => s.replace(KEPT, ' ')

// A prompt's spoken words, for telling whether two prompts are the same one.
export const promptKey = (s: string) => norm(withoutKept(s))

// Whether two prompts are the same text, pastes and all, spacing aside.
export const sameText = (a: string, b: string) => norm(a) === norm(b)

// Whether `said` is a prompt already sent this session, or the suggestion
// Tab takes: Up-arrow, Ctrl+R, rewind, a queued prompt pulled back and an
// accepted suggestion all put one in the box with no keystroke, just as tap
// dictation does. `messages` are the session's user messages, which carry
// any context blocks after the prompt: after a reload they are all we have.
export function wasSentBefore(said: string, sent: readonly string[], suggestion: string, messages: readonly string[]): boolean {
  const k = promptKey(said)
  if (k === '') return false
  if (sent.includes(k) || k === promptKey(suggestion)) return true
  return words(k) >= MIN_REWRITE_WORDS && messages.some(m => promptKey(m).startsWith(k))
}

// The prompt with each kept block swapped for a numbered marker, and the
// blocks in order. `pastes` are short pastes Claude Code put in the box
// as-is (no tags): each is kept too, where it still stands whole.
export function protect(text: string, pastes: readonly string[] = []): { spoken: string; blocks: string[] } {
  const blocks: string[] = []
  const keep = (block: string) => {
    blocks.push(block)
    return `[kept block ${blocks.length}]`
  }
  let spoken = text.replace(KEPT, keep)
  for (const paste of pastes) {
    const at = spoken.indexOf(paste)
    if (at !== -1) spoken = spoken.slice(0, at) + keep(paste) + spoken.slice(at + paste.length)
  }
  return { spoken, blocks }
}

// Kept blocks at the start or end of the prompt never reach the model, which
// could move them: only the spoken middle does, and the edges go back around
// its rewrite as they were. Blocks inside the speech stay as markers.
export function edges(marked: string): { head: string; body: string; tail: string } {
  const head = /^(?:\s*\[kept block \d+\])+\s*/.exec(marked)?.[0] ?? ''
  const rest = marked.slice(head.length)
  const tail = /\s*(?:\[kept block \d+\]\s*)+$/.exec(rest)?.[0] ?? ''
  return { head, body: rest.slice(0, rest.length - tail.length), tail }
}

// Puts the blocks back where the rewrite left their markers. null when the
// rewrite lost, repeated, reordered or invented a marker: then the prompt
// goes as spoken.
export function restore(rewrite: string, blocks: string[]): string | null {
  const found = [...rewrite.matchAll(MARKER)].map(m => Number(m[1]))
  if (found.length !== blocks.length || found.some((n, i) => n !== i + 1)) return null
  return rewrite.replace(MARKER, (_, n: string) => blocks[Number(n) - 1]!)
}

// lastBox is null when we don't know what was typed (the plugin just
// reloaded mid-draft, or another plugin filled the box): then never rewrite. Failing toward "typed"
// is safe; rewriting a typed prompt is not.
// `heard` is text that already landed between two edits (see register.ts).
export function isDictated(lastBox: string | null, submitted: string, heard = ''): boolean {
  if (lastBox === null) return false
  if (/\[Pasted text #\d+/.test(lastBox)) return false // a collapsed paste expanded
  if (submitted.trimStart().startsWith('/')) return false // a slash command
  return words(`${heard} ${untypedPart(lastBox, submitted)}`) >= 4 // at least 4 words came from voice
}

// A collapsed paste in the box that reached the prompt without its tags: it
// can't be told apart from speech, so nothing about the prompt is trusted.
export function pasteHidden(lastBox: string | null, submitted: string): boolean {
  return /\[Pasted text #\d+/.test(lastBox ?? '') && !/<pasted_content\b/.test(submitted)
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
- Keep every marker like [kept block 1] exactly as written, once each, where it stands. It stands for something the speaker pasted or typed (a paste, code, a file reference, an image), which you don't see.

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
