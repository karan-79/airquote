import type { EngineInterface, Register } from 'claude-code'

import {
  MIN_REWRITE_WORDS,
  MODES,
  TIMEOUT_MS,
  asMode,
  asModel,
  edges,
  effectiveMode,
  extractRewrite,
  isDictated,
  inserted,
  isVoiceHint,
  parseDictionary,
  pasteHidden,
  promptKey,
  promptFor,
  protect,
  restore,
  sameText,
  systemFor,
  untypedPart,
  wasSentBefore,
  withoutKept,
  words,
} from './rewrite'
import type { Mode, PromptContext, RewriteModel } from './rewrite'
import type { AirquoteRecall } from '../types/airquote'

// Prompts sent this session and the suggestion last shown: recalling either
// fills the box with no keystroke. Kept by the host (types/airquote.d.ts).
const RECALL = { plugin: 'airquote', key: 'recall' } as const
const MAX_RECALLED = 200
const MAX_REWRITES = 20
const MAX_REWRITE_CHARS = 20_000

async function recallState($: EngineInterface): Promise<AirquoteRecall> {
  const { value } = await $.state.get(RECALL).catch(() => ({ value: undefined }))
  return value ?? { sent: [], suggestion: '' }
}

async function remember($: EngineInterface, texts: string[], rewrite?: { from: string; to: string }): Promise<void> {
  const r = await recallState($)
  const keys = texts.map(promptKey).filter(k => k !== '' && !r.sent.includes(k))
  let rewrites = r.rewrites ?? []
  if (rewrite !== undefined && rewrite.from.length + rewrite.to.length <= MAX_REWRITE_CHARS) {
    rewrites = [...rewrites, rewrite].slice(-MAX_REWRITES)
  }
  await $.state.set(RECALL, { ...r, sent: [...r.sent, ...keys].slice(-MAX_RECALLED), rewrites }).catch(() => {})
}

type Settings = {
  mode: Mode
  model: RewriteModel
  dictionary: string[]
  instructions: string
  attachTranscript: boolean
  shareContext: boolean
}

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

// What happened to recent prompts, for `/airquote` to show. In memory only.
const decisions: string[] = []

function record(verdict: string, sent: string): void {
  const clip = sent.length > 80 ? sent.slice(0, 80) + '…' : sent
  decisions.push(`${new Date().toLocaleTimeString()}  ${verdict}  ${JSON.stringify(clip)}`)
  if (decisions.length > 10) decisions.shift()
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    mode: asMode(options.mode),
    model: asModel(options.model),
    dictionary: parseDictionary(String(options.dictionary ?? '')),
    instructions: String(options.instructions ?? ''),
    attachTranscript: options.attach_transcript !== false,
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
  // Text that landed in the box between two edits, which only voice does:
  // dictation the person then edited (hold mode lets them before Enter).
  let heard = ''
  // Short pastes since the box was emptied: they land as-is, with no tags,
  // so they are kept out of the rewrite by their text.
  let pastes: string[] = []

  on('session.start', async ($, e, next) => {
    try {
      const box = await $.prompt.read()
      if (lastBox === null && box.text === '') lastBox = ''
    } catch {
      // no prompt box (headless): stay unknown
    }
    await $.command.register({
      name: 'airquote',
      description: 'Show Airquote status, or set the rewrite mode',
      argumentHint: '[enhance|clean|off]',
    })
    return next(e)
  })

  // /airquote shows the mode and recent decisions; /airquote <mode> sets it.
  on('command.run', { command: 'airquote' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    if (wanted === '') {
      const recent = decisions.length > 0 ? decisions.join('\n') : '(no prompts since the last reload)'
      return { text: `Airquote mode: ${settings.mode} (model: ${settings.model})\n\nRecent prompts:\n${recent}` }
    }
    if (!MODES.includes(wanted as Mode)) {
      return { text: `Unknown mode "${wanted}". Use one of: ${MODES.join(', ')}` }
    }
    // Saved like a /config change; the plugin reloads with the new value.
    const r = await $.config.set({ key: 'airquote.mode', value: wanted })
    return { text: r.deny === undefined ? `Airquote mode set to ${wanted}.` : `Couldn't set the mode: ${r.deny}` }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (isVoiceHint(e.props.hint)) voiceSeen = true
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    if (lastBox !== null && e.text !== lastBox) heard += ` ${inserted(lastBox, e.text)}`
    // No key means a paste (or a burst of keys): either way, not speech.
    if (e.key === undefined && e.inputText.trim().length > 1) pastes.push(e.inputText)
    edits++
    const box = await next(e)
    lastBox = box.text
    return box
  })

  on('prompt.suggest', async ($, e, next) => {
    const r = await next(e)
    if (r.isShown) await $.state.set(RECALL, { ...(await recallState($)), suggestion: e.text }).catch(() => {})
    return r
  })

  // A `!` shell command never raises prompt.submit, so its keys would still
  // count against the next prompt. A turn starting with the box empty means
  // whatever was in it went: start counting afresh.
  on('turn.start', async ($, e, next) => {
    try {
      if ((await $.prompt.read()).text === '') {
        lastBox = ''
        edits = 0
        heard = ''
        pastes = []
      }
    } catch {
      // no prompt box: leave the state as it is
    }
    return next(e)
  })

  on('prompt.fill', async ($, e, next) => {
    lastBox = null
    heard = ''
    pastes = []
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const before = lastBox
    const seen = voiceSeen
    const editCount = edits
    const between = withoutKept(heard)
    const pasted = pastes
    lastBox = ''
    voiceSeen = false
    edits = 0
    heard = ''
    pastes = []
    // Pastes, code and host reminders are never speech: detect on the rest.
    // Slash commands and `!` shell commands are never rewritten.
    const said = withoutKept(e.text)
    if (e.origin.kind !== 'composer' || /^[/!]/.test(said.trimStart())) return next(e)

    // The tap and untyped-text rules count the person's keys, which only the
    // terminal reports: the desktop app and the IDE raise no prompt.edit, so
    // there every prompt would look dictated. A phone on Remote Control is
    // fine: what it sends arrives as origin `bridge`, skipped above.
    const surfaces = await $.session.surfaces().catch(() => [])
    const keysCounted = surfaces.includes('terminal') && surfaces.every(s => s === 'terminal' || s === 'mobile')

    // Sure: the hint line showed recording (hold), or text arrived with no
    // edits at all (tap). Guessed: enough words arrived that the edit hook
    // never saw (e.g. typing after a tap dictation). before === null means
    // the box's history is unknown, so zero edits proves nothing.
    const typedBefore = before === null || pasteHidden(before, e.text) ? null : withoutKept(before)
    const spoken = `${between} ${untypedPart(typedBefore ?? '', said)}`.trim()
    const counted =
      seen && words(spoken) > 0
        ? 'hold-to-talk'
        : !keysCounted
          ? null
          : typedBefore !== null && editCount === 0 && said.trim() !== ''
            ? 'tap (no keystrokes)'
            : isDictated(typedBefore, said, between)
              ? 'untyped text'
              : null
    // Hold mode is sure; the keystroke rules can't tell a recalled prompt or
    // an accepted suggestion from tap dictation, so rule those out.
    let recalled = false
    if (counted !== null && counted !== 'hold-to-talk') {
      const { sent, suggestion } = await recallState($)
      const messages = await $.session
        .messages()
        .then(ms => ms.filter(m => m.role === 'user').map(m => m.text))
        .catch(() => [])
      recalled = wasSentBefore(said, sent, suggestion, messages)
    }
    // A dictation recalled from history (which holds the raw words) goes as
    // it was cleaned last time, with no new rewrite.
    const earlier = recalled ? (await recallState($)).rewrites?.findLast(r => sameText(r.from, e.text)) : undefined
    if (earlier !== undefined) {
      record('voice, recalled: sent as cleaned before', said)
      const again = 'This prompt was dictated with voice mode earlier and recalled from history; Airquote sent the cleanup it made then.'
      return next({ ...e, text: earlier.to, context: [...(e.context ?? []), again] })
    }
    const how = recalled ? null : counted
    await remember($, [e.text])
    if (how === null) {
      record(recalled ? 'typed (recalled or suggested)' : 'typed', said)
      return next(e)
    }

    // Always tell Claude the prompt was spoken, rewritten or not.
    const note = `This prompt was dictated with voice mode (detected by ${how}).`
    const passOn = (verdict: string) => {
      record(verdict, said)
      return next({ ...e, context: [...(e.context ?? []), note] })
    }

    if (settings.mode === 'off') return passOn('voice, mode off')
    if (words(spoken) < MIN_REWRITE_WORDS) return passOn('voice, too short to rewrite')
    // A collapsed paste that didn't arrive in tags can't be told apart from
    // speech, so the whole prompt would reach the model: don't rewrite.
    if (pasteHidden(before, e.text)) {
      return passOn('voice, paste not separable')
    }
    const mode = effectiveMode(settings.mode, spoken)

    // The model gets only the spoken middle, with markers for any kept block
    // inside it; never the blocks, and never the ones around it.
    const { spoken: marked, blocks } = protect(e.text, pasted)
    const { head, body: dictated, tail } = edges(marked)

    $.ui.status(mode === 'enhance' ? 'Airquote: enhancing dictation…' : 'Airquote: cleaning dictation…')
    let reply: string | null = null
    let failure = ''
    try {
      const ctx = await gatherContext($, settings)
      const r = await $.model.complete({
        model: settings.model,
        system: systemFor(mode, settings.instructions),
        prompt: promptFor(dictated, ctx),
        effort: 'low',
        maxTokens: 3000,
        timeoutMs: TIMEOUT_MS[settings.model],
      })
      if (r.isAnswered) reply = r.text
      else failure = r.reason
    } catch {
      failure = 'call refused' // e.g. the model is blocked: still send the voice note
    } finally {
      $.ui.status(undefined)
    }

    const result = reply === null ? null : extractRewrite(reply)
    const text = result === null ? null : restore(head + result.text + tail, blocks)
    if (result !== null && text === null) failure = 'pasted text moved or lost'
    if (result === null || text === null || text === e.text.trim()) {
      return passOn(`voice, ${mode}, kept as spoken${failure === '' ? '' : ` (${failure})`}`)
    }
    if (result.unclear) {
      $.ui.toast('Airquote: the dictation was unclear, so it was only cleaned up, not restructured.')
    }
    record(`voice, ${mode}${result.unclear ? ', unclear: cleaned only' : ''}`, said)
    await remember($, [text], { from: e.text, to: text })

    // By default Claude also gets the raw transcript, in case the rewrite lost
    // or added something. The attach_transcript setting turns that off.
    const kept = blocks.length > 0 ? ' [kept block N] marks a paste, code or reference left unchanged in the prompt.' : ''
    const raw = `Raw voice transcript before Airquote ${mode === 'enhance' && !result.unclear ? 'enhanced' : 'cleaned'} it (trust this over the rewrite if they differ in meaning).${kept}\n${marked}`
    return next({
      ...e,
      text,
      context: [...(e.context ?? []), note, ...(settings.attachTranscript ? [raw] : [])],
    })
  })
}
