// End-to-end tests: real hook chains, with the engine beneath the plugin
// stubbed (prompt box, Haiku, git, status line).
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Args, On } from 'claude-code'

type Sent = { text: string; context: readonly string[] }

// Stubs everything the plugin calls beneath it. `reply` is what Haiku answers.
function engine(on: On, reply: string | null) {
  const sent: Sent[] = []
  const asked: string[] = []
  const calls: { model: string; timeoutMs?: number }[] = []
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
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'src/auth/login.ts\n', stderr: '' } }) as never)
  on('session.messages', () => ({ value: [] }) as never)
  on('model.complete', ($, e) => {
    asked.push(`${e.system ?? ''}\n${e.prompt}`)
    calls.push({ model: e.model, timeoutMs: e.timeoutMs })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const value = reply === null ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text: reply, usage }
    return { value } as never
  })
  return { sent, asked, calls, setBox: (t: string) => (box = t) }
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

// The kit raises `prompt.edit` (a person typing) at runtime, but its types
// don't list it on `$.prompt`, so type it here.
type EditCall = (e: Args<'prompt.edit'>) => Promise<{ text: string; cursor: number }>

async function type($: Engine, text: string) {
  const edit = ($.prompt as unknown as { edit: EditCall }).edit
  let box = ''
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
})
