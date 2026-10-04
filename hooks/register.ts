import type { EngineInterface, Register } from 'claude-code'

import {
  MIN_REWRITE_WORDS,
  MODES,
  asMode,
  effectiveMode,
  extractRewrite,
  isDictated,
  isVoiceHint,
  parseDictionary,
  promptFor,
  systemFor,
  untypedPart,
  words,
} from './rewrite'
import type { Mode, PromptContext } from './rewrite'

type Settings = { mode: Mode; dictionary: string[]; instructions: string; shareContext: boolean }

async function gatherContext($: EngineInterface, settings: Settings): Promise<PromptContext> {
  if (!settings.shareContext) return { dictionary: settings.dictionary, files: [], recent: [] }
  const [files, recent] = await Promise.all([
    $.process
      .run(['git', 'ls-files'], { timeoutMs: 3000 })
      .then(r => (r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : []))
      .catch(() => []),
    $.session
      .messages()
      .then(ms =>
        ms
          .filter(m => m.text.trim() !== '')
          .slice(-4)
          .map(m => ({ role: m.role, text: m.text })),
      )
      .catch(() => []),
  ])
  return { dictionary: settings.dictionary, files, recent }
}

// What happened to recent prompts, for `/saywright` to show. In memory only.
const decisions: string[] = []

function record(verdict: string, sent: string): void {
  const clip = sent.length > 80 ? sent.slice(0, 80) + '…' : sent
  decisions.push(`${new Date().toLocaleTimeString()}  ${verdict}  ${JSON.stringify(clip)}`)
  if (decisions.length > 10) decisions.shift()
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    mode: asMode(options.mode),
    dictionary: parseDictionary(String(options.dictionary ?? '')),
    instructions: String(options.instructions ?? ''),
    shareContext: options.share_context !== false,
  }

  // The box as the person's own keys and pastes left it. '' = empty box,
  // null = unknown: a (re)load starts unknown until session.start finds the
  // box empty.
  let lastBox: string | null = null
  // Set when the hint line shows hold-to-talk recording; cleared on submit.
  let voiceSeen = false
  // Key presses and pastes since the box was last emptied by a submit. Tap
  // mode only starts from an empty box and its text arrives without any
  // edit, so a prompt sent with zero edits was dictated.
  let edits = 0

  on('session.start', async ($, e, next) => {
    try {
      const box = await $.prompt.read()
      if (lastBox === null && box.text === '') lastBox = ''
    } catch {
      // no prompt box (headless): stay unknown
    }
    await $.command.register({
      name: 'saywright',
      description: 'Show Saywright status, or set the rewrite mode',
      argumentHint: '[enhance|clean|off]',
    })
    return next(e)
  })

  // /saywright shows the mode and recent decisions; /saywright <mode> sets it.
  on('command.run', { command: 'saywright' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    if (wanted === '') {
      const recent = decisions.length > 0 ? decisions.join('\n') : '(no prompts since the last reload)'
      return { text: `Saywright mode: ${settings.mode}\n\nRecent prompts:\n${recent}` }
    }
    if (!MODES.includes(wanted as Mode)) {
      return { text: `Unknown mode "${wanted}". Use one of: ${MODES.join(', ')}` }
    }
    // Saved like a /config change; the plugin reloads with the new value.
    const r = await $.config.set({ key: 'saywright.mode', value: wanted })
    return { text: r.deny === undefined ? `Saywright mode set to ${wanted}.` : `Couldn't set the mode: ${r.deny}` }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (isVoiceHint(e.props.hint)) voiceSeen = true
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    edits++
    const box = await next(e)
    lastBox = box.text
    return box
  })

  on('prompt.fill', async ($, e, next) => {
    lastBox = null
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const before = lastBox
    const seen = voiceSeen
    const editCount = edits
    lastBox = ''
    voiceSeen = false
    edits = 0
    if (e.origin.kind !== 'composer' || e.text.trimStart().startsWith('/')) return next(e)

    // Sure: the hint line showed recording (hold), or text arrived with no
    // edits at all (tap). Guessed: enough words arrived that the edit hook
    // never saw (e.g. typing after a tap dictation). before === null means
    // the box's history is unknown, so zero edits proves nothing.
    const spoken = untypedPart(before ?? '', e.text)
    const how =
      seen && words(spoken) > 0
        ? 'hold-to-talk'
        : before !== null && editCount === 0 && e.text.trim() !== ''
          ? 'tap (no keystrokes)'
          : isDictated(before, e.text)
            ? 'untyped text'
            : null
    if (how === null) {
      record('typed', e.text)
      return next(e)
    }

    // Always tell Claude the prompt was spoken, rewritten or not.
    const note = `This prompt was dictated with voice mode (detected by ${how}).`
    const passOn = (verdict: string) => {
      record(verdict, e.text)
      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    if (settings.mode === 'off') return passOn('voice, mode off')
    if (words(spoken) < MIN_REWRITE_WORDS) return passOn('voice, too short to rewrite')
    const mode = effectiveMode(settings.mode, spoken)

    $.ui.status(mode === 'enhance' ? 'Saywright: enhancing dictation…' : 'Saywright: cleaning dictation…')
    const ctx = await gatherContext($, settings)
    const r = await $.model.complete({
      model: 'haiku',
      system: systemFor(mode, settings.instructions),
      prompt: promptFor(e.text, ctx),
      effort: 'low',
      maxTokens: 3000,
      timeoutMs: 15000,
    })
    $.ui.status(undefined)

    const rewritten = r.isAnswered ? extractRewrite(r.text) : null
    if (rewritten === null || rewritten === e.text.trim()) return passOn(`voice, ${mode}, kept as spoken`)
    record(`voice, ${mode}`, e.text)

    return next({
      ...e,
      text: rewritten,
      // Claude still sees the raw transcript, in case the rewrite lost or added something.
      context: [
        ...(e.context ?? []),
        note,
        `Raw voice transcript before Saywright ${mode === 'enhance' ? 'enhanced' : 'cleaned'} it (trust this over the rewrite if they differ in meaning):\n${e.text}`,
      ],
    })
  })
}
