// End-to-end tests: real hook chains, with the engine beneath the plugin
// stubbed (prompt box, Haiku, git, status line).
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

type Sent = { text: string; context: readonly string[] }

// Stubs everything the plugin calls beneath it. `reply` is what Haiku answers.
function engine(on: On, reply: string | null, surfaces: string[] = ['terminal'], history: string[] = []) {
  const sent: Sent[] = []
  const asked: string[] = []
  const calls: { model: string; timeoutMs?: number }[] = []
  const toasts: string[] = []
  let box = ''

  on('session.start', ($, e) => ({ cwd: e.cwd, startedAt: 0 }) as never)
  // Calls a plugin makes on `$` answer { value } (or { deny }).
  on('command.register', () => ({ value: undefined }) as never)
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }) as never)
  on('prompt.edit', ($, e) => {
    box = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text: box, cursor: e.start + e.inputText.length }
  })
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, context: e.context ?? [] })
    box = ''
    return { text: e.text, context: e.context }
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined } as never
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'src/auth/login.ts\n', stderr: '' } }) as never)
  on('session.messages', () => ({ value: history.map(text => ({ role: 'user', text, toolUses: [] })) }) as never)
  on('prompt.suggest', () => ({ isShown: true }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('session.surfaces', () => ({ value: surfaces }) as never)
  // The host's session state, which outlives a reload of the plugin.
  const state = new Map<string, unknown>()
  on('state.get', ($, e) => ({ value: { value: state.get(e.key), version: 0 } }) as never)
  on('state.set', ($, e) => {
    state.set(e.key, (e as { value: unknown }).value)
    return { value: { isSet: true, version: 1 } } as never
  })
  on('model.complete', ($, e) => {
    asked.push(`${e.system ?? ''}\n${e.prompt}`)
    calls.push({ model: e.model, timeoutMs: e.timeoutMs })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const value = reply === null ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text: reply, usage }
    return { value } as never
  })
  return { sent, asked, calls, toasts, state, setBox: (t: string) => (box = t) }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

// The kit raises `prompt.edit` (a person typing) at runtime, but its types
// don't list it on `$.prompt`, so type it here.
type EditCall = (e: Args<'prompt.edit'>) => Promise<{ text: string; cursor: number }>

// `box` is the draft the keys start from: pass what voice left in the box to
// type after a dictation.
async function type($: Engine, text: string, box = '') {
  const edit = ($.prompt as unknown as { edit: EditCall }).edit
  for (const ch of text) {
    const r = await edit({ origin: { kind: 'composer' }, text: box, cursor: box.length, start: box.length, end: box.length, inputText: ch })
    box = r.text
  }
}

const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const SPEECH = 'um so can you uh check why the login page is slow on mobile please'
const CLEAN = 'Can you check why the login page is slow on mobile?'

describe('typed prompts', () => {
  test('are sent untouched, with no voice note and no model call', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await type($, SPEECH)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.sent[0]?.context).toEqual([])
    expect(s.asked.length).toBe(0)
  })
})

describe('tap dictation (text arrives with no keystrokes)', () => {
  test('is rewritten, with the voice note and raw transcript as context', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by tap (no keystrokes)')
    expect(s.sent[0]?.context.join('\n')).toContain(SPEECH)
    expect(s.asked[0]).toContain('src/auth/login.ts') // repo context shared by default
  })

  test('is kept as spoken when Haiku answers instead of rewriting', async ($, on) => {
    const s = engine(on, 'I need more context. Could you clarify what you want?')
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.sent[0]?.context.join('\n')).toContain('dictated with voice mode')
  })

  test('is kept as spoken when the model call fails', async ($, on) => {
    const s = engine(on, null)
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
  })

  test('is not rewritten when the plugin loaded mid-draft (box not empty)', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    s.setBox('half typed')
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.asked.length).toBe(0)
  })
})

describe('hold dictation', () => {
  test('the "keep holding" hint marks the prompt as spoken', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'hint') as never
    })
    await start($)
    await type($, '   ') // holding space types a few spaces first
    await $.ui.render({
      component: 'PromptHint',
      surface: 'terminal',
      requestId: 'hint',
      props: { hint: '(shift+tab to cycle) · keep holding…', isDraft: true, isWorking: false },
    } as never)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by hold-to-talk')
  })
})

describe('settings', () => {
  test('mode off only adds the voice note', { options: { mode: 'off' } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.sent[0]?.context.join('\n')).toContain('dictated with voice mode')
    expect(s.asked.length).toBe(0)
  })

  test('share_context off sends no repo files', { options: { share_context: false } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.asked[0]).not.toContain('src/auth/login.ts')
  })

  test('dictionary terms reach the model', { options: { dictionary: 'Kubernetes, Tailwind' } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.asked[0]).toContain('Kubernetes')
  })

  test('extra instructions reach the model', { options: { instructions: 'write in British English' } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.asked[0]).toContain('write in British English')
  })

  test('haiku is the default model', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.calls[0]).toEqual({ model: 'haiku', timeoutMs: 15000 })
  })

  test('a chosen model and its longer time limit reach the call', { options: { model: 'opus' } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.calls[0]).toEqual({ model: 'opus', timeoutMs: 40000 })
  })

  test('attach_transcript off sends the rewrite and voice note, not the raw words', { options: { attach_transcript: false } }, async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('dictated with voice mode')
    expect(s.sent[0]?.context.join('\n')).not.toContain(SPEECH)
  })

  test('an unclear dictation in enhance mode is cleaned only, with a toast', async ($, on) => {
    const s = engine(on, '<cleaned>so the, the thing it broke when I did the other one</cleaned>')
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe('so the, the thing it broke when I did the other one')
    expect(s.toasts.length).toBe(1)
    expect(s.toasts[0]).toContain('unclear')
    expect(s.sent[0]?.context.join('\n')).toContain('before Airquote cleaned it')
  })

  test('a clear dictation shows no toast', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    expect(s.toasts.length).toBe(0)
  })
})

describe('pastes and host blocks', () => {
  const PASTE = '<pasted_content id="a1">12:00  voice, enhance  "Uh, what project"\nUh, keep this um</pasted_content>'
  const REMINDER = '<system-reminder>\nThe user started this session in a scratch folder.\n</system-reminder>'

  test('a prompt that is only a paste passes through unchanged', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, PASTE)
    expect(s.sent[0]?.text).toBe(PASTE)
    expect(s.sent[0]?.context).toEqual([])
    expect(s.asked.length).toBe(0)
  })

  test('a dictation around a paste keeps the paste byte-identical', async ($, on) => {
    const s = engine(on, '<rewrite>Can you check why this log is slow? [kept block 1] Thanks.</rewrite>')
    await start($)
    await submit($, `um can you uh check why this log is slow ${PASTE} thanks`)
    expect(s.sent[0]?.text).toBe(`Can you check why this log is slow? ${PASTE} Thanks.`)
    expect(s.asked[0]).not.toContain('keep this')
    expect(s.asked[0]).toContain('[kept block 1]')
  })

  test('a leading system reminder is never sent to the model', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, `${REMINDER}\n${SPEECH}`)
    expect(s.asked[0]).not.toContain('scratch folder')
    expect(s.asked[0]?.split('<dictation>')[1]).not.toContain('[kept block')
    expect(s.sent[0]?.text).toBe(`${REMINDER}\n${CLEAN}`)
  })

  test('a paste at the end stays at the end, whatever the model does', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, `${SPEECH}\n\n${PASTE}`)
    expect(s.asked[0]?.split('<dictation>')[1]).not.toContain('[kept block')
    expect(s.sent[0]?.text).toBe(`${CLEAN}\n\n${PASTE}`)
  })

  test('a paste first and speech after keep that order (the speech is not moved in front)', async ($, on) => {
    const s = engine(on, '<rewrite>Can you simplify this?</rewrite>')
    await start($)
    await submit($, `\n\n${PASTE}\n\n uh how do I say this, can you can you simplify this`)
    expect(s.sent[0]?.text).toBe(`\n\n${PASTE}\n\n Can you simplify this?`)
  })

  test('a rewrite that moves an inner marker is sent as spoken', async ($, on) => {
    const s = engine(on, '<rewrite>[kept block 2] Compare [kept block 1] with this.</rewrite>')
    await start($)
    const prompt = `um compare \`a()\` with uh \`b()\` please`
    await submit($, prompt)
    expect(s.sent[0]?.text).toBe(prompt)
  })

  test('a rewrite that loses an inner marker is sent as spoken', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    const prompt = `um so check ${PASTE} and uh tell me why it fails`
    await submit($, prompt)
    expect(s.sent[0]?.text).toBe(prompt)
    expect(s.sent[0]?.context.join('\n')).toContain('dictated with voice mode')
  })
})

describe('hold dictation with a paste', () => {
  const PASTE = '<pasted_content id="a1">uh line one\nline two um\nline three</pasted_content>'
  const holdHint = async ($: Engine) =>
    $.ui.render({
      component: 'PromptHint',
      surface: 'terminal',
      requestId: 'hint',
      props: { hint: '(shift+tab to cycle) · keep holding…', isDraft: true, isWorking: false },
    } as never)

  const pasteThenHold = async ($: Engine, on: On) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'hint') as never
    })
    await start($)
    await type($, '[Pasted text #1 +3 lines] ') // the collapsed paste in the box
    await holdHint($)
  }

  test('speech after a paste is rewritten and the paste stays byte-identical', async ($, on) => {
    const s = engine(on, '<rewrite>Why does this fail?</rewrite>')
    await pasteThenHold($, on)
    await submit($, `${PASTE} um why does this uh fail`)
    expect(s.sent[0]?.text).toBe(`${PASTE} Why does this fail?`)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by hold-to-talk')
    expect(s.asked[0]).not.toContain('line two')
  })

  test('a paste that arrives without tags is not rewritten', async ($, on) => {
    const s = engine(on, '<rewrite>Why does this fail?</rewrite>')
    await pasteThenHold($, on)
    const prompt = 'uh line one\nline two um\nline three um why does this uh fail'
    await submit($, prompt)
    expect(s.sent[0]?.text).toBe(prompt)
    expect(s.sent[0]?.context.join('\n')).toContain('dictated with voice mode')
    expect(s.asked.length).toBe(0)
  })
})

describe('cli edge cases', () => {
  const drawHint = (on: On) =>
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'hint') as never
    })
  const holdHint = ($: Engine) =>
    $.ui.render({
      component: 'PromptHint',
      surface: 'terminal',
      requestId: 'hint',
      props: { hint: '(shift+tab to cycle) · keep holding…', isDraft: true, isWorking: false },
    } as never)

  test('a hold dictation the person then edits is still rewritten', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    drawHint(on)
    await start($)
    await holdHint($)
    await type($, '!', SPEECH) // voice put SPEECH in the box, then a key
    await submit($, `${SPEECH}!`)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by hold-to-talk')
  })

  test('typing, then dictation, then more typing is caught as untyped text', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await type($, 'so ')
    await type($, ' ok', `so ${SPEECH}`)
    await submit($, `so ${SPEECH} ok`)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by untyped text')
  })

  test('a shell command is never rewritten', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, '!git log --oneline um the last five')
    expect(s.sent[0]?.text).toBe('!git log --oneline um the last five')
    expect(s.asked.length).toBe(0)
  })

  test('typed code and file mentions around a dictation are kept and never sent', async ($, on) => {
    const s = engine(on, '<rewrite>Why does [kept block 2] throw here?</rewrite>')
    drawHint(on)
    await start($)
    await type($, '@src/auth/login.ts ')
    await holdHint($)
    await submit($, '@src/auth/login.ts um why does `parseToken(raw)` uh throw here')
    expect(s.sent[0]?.text).toBe('@src/auth/login.ts Why does `parseToken(raw)` throw here?')
    expect(s.asked[0]).not.toContain('parseToken')
  })
})

describe('prompts that fill the box without keys', () => {
  test('an Up-arrow recall of a typed prompt is not taken for tap dictation', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await type($, SPEECH)
    await submit($, SPEECH)
    await submit($, SPEECH) // Up, Enter: the same text, no keys
    expect(s.sent[1]?.text).toBe(SPEECH)
    expect(s.sent[1]?.context).toEqual([])
    expect(s.asked.length).toBe(0)
  })

  test('a recalled dictation goes as it was cleaned before, with no new call', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await submit($, SPEECH)
    await submit($, SPEECH) // Ctrl+R or Up shows the raw words
    await submit($, CLEAN)
    expect(s.asked.length).toBe(1)
    expect(s.sent[1]?.text).toBe(CLEAN)
    expect(s.sent[1]?.context.join('\n')).toContain('recalled from history')
    expect(s.sent[2]?.text).toBe(CLEAN)
    expect(s.sent[2]?.context).toEqual([])
  })

  test('after a reload, a prompt already in the transcript counts as recalled', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`, ['terminal'], [`${SPEECH}\nThis prompt was dictated with voice mode.`])
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.asked.length).toBe(0)
  })

  test('what was sent and suggested is kept by the host', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await $.prompt.suggest({ text: 'run the tests again please', origin: { kind: 'suggestion' } } as never)
    await submit($, SPEECH)
    expect(s.state.get('recall')).toEqual({
      suggestion: 'run the tests again please',
      sent: [SPEECH, CLEAN],
      rewrites: [{ from: SPEECH, to: CLEAN }],
    })
  })

  test('after a reload, a recalled raw dictation or an old suggestion is still typed', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    // What the host kept from before the reload; the transcript only has the rewrite.
    s.state.set('recall', { sent: [SPEECH, CLEAN], suggestion: 'show me where the catalog cache gets invalidated' })
    await start($)
    await submit($, SPEECH) // Ctrl+R to the raw dictation
    await submit($, 'show me where the catalog cache gets invalidated') // Tab
    expect(s.asked.length).toBe(0)
    expect(s.sent.map(p => p.context)).toEqual([[], []])
  })

  test('an accepted suggestion is not taken for tap dictation', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await $.prompt.suggest({ text: 'update the readme with the new setting', origin: { kind: 'suggestion' } } as never)
    await submit($, 'update the readme with the new setting')
    expect(s.sent[0]?.context).toEqual([])
    expect(s.asked.length).toBe(0)
  })

  test('keys of a shell command do not hide the next tap dictation', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await type($, 'ls -la') // shell mode: these keys never reach prompt.submit
    s.setBox('')
    await $.turn.start({ text: '', turnId: 't1' })
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by tap (no keystrokes)')
  })
})

describe('short pastes', () => {
  // A short paste is one edit with no key, its text as-is in the box.
  const paste = ($: Engine, text: string, box = '') =>
    ($.prompt as unknown as { edit: EditCall }).edit({ origin: { kind: 'composer' }, text: box, cursor: box.length, start: box.length, end: box.length, inputText: text })
  const CMD = 'kubectl get pods -n uh-prod --watch'

  test('a short paste in a hold dictation is never sent to the model', async ($, on) => {
    const s = engine(on, '<rewrite>Why does this hang?</rewrite>')
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, 'hint') as never
    })
    await start($)
    await paste($, CMD)
    await $.ui.render({
      component: 'PromptHint',
      surface: 'terminal',
      requestId: 'hint',
      props: { hint: '(shift+tab to cycle) · keep holding…', isDraft: true, isWorking: false },
    } as never)
    await submit($, `${CMD} um why does this uh hang`)
    expect(s.asked[0]).not.toContain('kubectl')
    expect(s.sent[0]?.text).toBe(`${CMD} Why does this hang?`)
  })

  test('a short paste on its own is typed', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await paste($, CMD)
    await submit($, CMD)
    expect(s.sent[0]?.text).toBe(CMD)
    expect(s.asked.length).toBe(0)
  })
})

describe('surfaces', () => {
  test('on desktop, a prompt with zero edits is treated as typed', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`, ['desktop'])
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.sent[0]?.context).toEqual([])
    expect(s.asked.length).toBe(0)
  })

  test('with Remote Control attached, terminal prompts are still checked', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`, ['terminal', 'mobile'])
    await start($)
    await submit($, SPEECH)
    expect(s.sent[0]?.text).toBe(CLEAN)
  })

  test('a prompt sent from the phone is never touched', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`, ['terminal', 'mobile'])
    await start($)
    await $.prompt.submit({ text: SPEECH, wait: false, origin: { kind: 'bridge' } })
    expect(s.sent[0]?.text).toBe(SPEECH)
    expect(s.asked.length).toBe(0)
  })

  test('with the desktop app or the IDE attached, untyped text is treated as typed', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`, ['terminal', 'vscode'])
    await start($)
    await type($, 'so ')
    await submit($, `so ${SPEECH}`)
    expect(s.asked.length).toBe(0)
  })

  test('in the terminal after typing, untyped text is still caught', async ($, on) => {
    const s = engine(on, `<rewrite>${CLEAN}</rewrite>`)
    await start($)
    await type($, 'so ')
    await submit($, `so ${SPEECH}`)
    expect(s.sent[0]?.text).toBe(CLEAN)
    expect(s.sent[0]?.context.join('\n')).toContain('detected by untyped text')
  })
})
