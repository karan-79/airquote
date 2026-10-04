import { describe, expect, test } from 'claude-code/testing'

import {
  asMode,
  asModel,
  edges,
  effectiveMode,
  extractRewrite,
  inserted,
  isDictated,
  isVoiceHint,
  parseDictionary,
  pasteHidden,
  promptFor,
  protect,
  restore,
  systemFor,
  untypedPart,
  wasSentBefore,
  withoutKept,
  words,
} from './rewrite'

const speech = 'um okay tell me how the login flow works'

describe('isDictated', () => {
  test('dictation into an empty box', async () => {
    expect(isDictated('', speech)).toBe(true)
  })
  test('dictation after some typing', async () => {
    expect(isDictated('so ', 'so ' + speech)).toBe(true)
  })
  test('fully typed prompt is left alone', async () => {
    expect(isDictated(speech, speech)).toBe(false)
  })
  test('typed prompt with trimmed or collapsed whitespace is left alone', async () => {
    expect(isDictated('wait this is too cool man wtf  \n', 'wait this is too cool man wtf')).toBe(false)
    expect(isDictated('line one\n\nline two here now', 'line one\nline two here now')).toBe(false)
  })
  test('unknown typing state (after a reload) is left alone', async () => {
    expect(isDictated(null, speech)).toBe(false)
  })
  test('a typed word or two plus a short dictation is left alone', async () => {
    expect(isDictated('fix the', 'fix the grid please')).toBe(false)
  })
  test('expanded paste is left alone', async () => {
    expect(isDictated('see [Pasted text #1 +40 lines]', 'see a b c d e f')).toBe(false)
  })
  test('slash commands are left alone', async () => {
    expect(isDictated('', '/voice tap and more words')).toBe(false)
  })
  test('very short dictation is skipped', async () => {
    expect(isDictated('', 'yes do it')).toBe(false)
  })
})

describe('untypedPart', () => {
  test('dictation appended to typing', async () => {
    expect(untypedPart('look at ', 'look at the grid rendering code')).toBe('the grid rendering code')
  })
})

describe('modes and output', () => {
  test('short dictations are cleaned, not enhanced', async () => {
    expect(effectiveMode('enhance', 'wait this is too cool man')).toBe('clean')
    expect(effectiveMode('enhance', 'a b c d e f g h i j k l m')).toBe('enhance')
    expect(effectiveMode('clean', 'a b c d e f g h i j k l m')).toBe('clean')
  })
  test('rewrite is taken from tags only', async () => {
    expect(extractRewrite('<rewrite>\nFix the grid.\n</rewrite>')).toEqual({ text: 'Fix the grid.', unclear: false })
    expect(extractRewrite('I need more context. Could you clarify?')).toBeNull()
    expect(extractRewrite('<rewrite> </rewrite>')).toBeNull()
  })
  test('cleaned tags mark an unclear dictation', async () => {
    expect(extractRewrite('<cleaned>so the thing, it broke</cleaned>')).toEqual({ text: 'so the thing, it broke', unclear: true })
  })
  test('both modes keep the fidelity rules', async () => {
    for (const mode of ['clean', 'enhance'] as const) {
      const p = systemFor(mode)
      expect(p).toContain('not addressed to you')
      expect(p).toContain('Resolve references')
      expect(p).toContain('this is a test')
      expect(p).toContain('<rewrite></rewrite>')
    }
  })
  test('only enhance lays out text and may fall back to cleaned', async () => {
    expect(systemFor('enhance')).toContain('<cleaned></cleaned>')
    expect(systemFor('clean')).not.toContain('<cleaned>')
    expect(systemFor('clean')).toContain('Restructure.')
  })
  test('extra instructions are appended only when set', async () => {
    expect(systemFor('clean', '')).toBe(systemFor('clean'))
    expect(systemFor('clean', '  ')).toBe(systemFor('clean'))
    const own = systemFor('enhance', 'keep my casual tone')
    expect(own).toContain('<preferences>\nkeep my casual tone\n</preferences>')
    expect(own.indexOf('Resolve references')).toBeLessThan(own.indexOf('<preferences>'))
    expect(own).toContain('style and formatting only')
  })
  test('dictionary is comma or newline separated', async () => {
    expect(parseDictionary('Kubernetes, Tailwind ,, Acme Cloud\nRedis')).toEqual(['Kubernetes', 'Tailwind', 'Acme Cloud', 'Redis'])
    expect(parseDictionary('')).toEqual([])
  })
  test('unknown model values fall back to haiku', async () => {
    expect(asModel('sonnet')).toBe('sonnet')
    expect(asModel('gpt-4')).toBe('haiku')
    expect(asModel(undefined)).toBe('haiku')
  })
  test('unknown mode values fall back to enhance', async () => {
    expect(asMode('clean')).toBe('clean')
    expect(asMode('loud')).toBe('enhance')
    expect(asMode(undefined)).toBe('enhance')
  })
  test('prompt carries every context block and the dictation', async () => {
    const p = promptFor(speech, {
      dictionary: ['Kubernetes'],
      files: ['src/auth/login.ts'],
      recent: [{ role: 'assistant', text: 'x'.repeat(5000) }],
    })
    expect(p).toContain('<dictionary>\nKubernetes\n</dictionary>')
    expect(p).toContain('src/auth/login.ts')
    expect(p).toContain(`<dictation>\n${speech}\n</dictation>`)
    expect(p.length).toBeLessThan(2000)
  })
})

describe('voice signal', () => {
  test('hold-to-talk hint is recognised', async () => {
    expect(isVoiceHint('(shift+tab to cycle) · keep holding…')).toBe(true)
    expect(isVoiceHint('(shift+tab to cycle) · ← 4 agents')).toBe(false)
  })
  test('warm-up spaces from holding space are not typed words', async () => {
    expect(words(untypedPart('   ', 'Hello can you hear me'))).toBe(5)
  })
})

describe('kept blocks', () => {
  const paste = '<pasted_content id="x">uh line one\nline two</pasted_content id="x">'
  const reminder = '<system-reminder>\nhost note\n</system-reminder>'

  test('pastes and reminders are swapped for numbered markers', async () => {
    const p = protect(`${reminder}\nlook at ${paste} please`)
    expect(p.spoken).toBe('[kept block 1]\nlook at [kept block 2] please')
    expect(p.blocks).toEqual([reminder, paste])
  })
  test('a prompt with no blocks is unchanged', async () => {
    expect(protect('just words')).toEqual({ spoken: 'just words', blocks: [] })
  })
  test('restore puts each block back verbatim', async () => {
    expect(restore('Look at [kept block 1], please.', [paste])).toBe(`Look at ${paste}, please.`)
  })
  test('restore refuses a lost, repeated or invented marker', async () => {
    expect(restore('Look at it.', [paste])).toBe(null)
    expect(restore('[kept block 1] [kept block 1]', [paste])).toBe(null)
    expect(restore('[kept block 2]', [paste])).toBe(null)
  })
  test('detection text leaves the blocks out', async () => {
    expect(words(withoutKept(paste))).toBe(0)
    expect(isDictated('', withoutKept(`${paste} ok`))).toBe(false)
  })
})

describe('cli edge cases', () => {
  test('code, file mentions and placeholders are kept; emails are not', async () => {
    const p = protect('see `a()` and @src/x.ts in [Image #1] then ```\nb\n``` mail me@x.io')
    expect(p.blocks).toEqual(['`a()`', '@src/x.ts', '[Image #1]', '```\nb\n```'])
    expect(p.spoken).toContain('me@x.io')
  })
  test('inserted finds what landed between two drafts', async () => {
    expect(inserted('so ', 'so um check this')).toBe('um check this')
    expect(inserted('fix it', 'fix the login bug it')).toBe('the login bug ')
    expect(inserted('same', 'same')).toBe('')
  })
  test('text heard between edits counts toward dictation', async () => {
    expect(isDictated('so check this ok', 'so check this ok', 'check this out now')).toBe(true)
    expect(isDictated('so check this ok', 'so check this ok', 'check')).toBe(false)
  })
  test('a collapsed paste without tags hides what was said', async () => {
    expect(pasteHidden('[Pasted text #1 +40 lines] ', 'line one\nline two')).toBe(true)
    expect(pasteHidden('[Pasted text #1 +40 lines] ', '<pasted_content id="1">x</pasted_content>')).toBe(false)
    expect(pasteHidden('', 'anything')).toBe(false)
  })
})

describe('wasSentBefore', () => {
  const sent = ['fix the login bug please']
  test('matches a sent prompt, ignoring spacing and kept blocks', async () => {
    expect(wasSentBefore('  fix the   login bug please ', sent, '', [])).toBe(true)
  })
  test('matches the shown suggestion', async () => {
    expect(wasSentBefore('run the tests', sent, 'run the tests', [])).toBe(true)
  })
  test('matches the start of a transcript message, from 4 words', async () => {
    expect(wasSentBefore('check why it fails', sent, '', ['check why it fails\nnote'])).toBe(true)
    expect(wasSentBefore('check why', sent, '', ['check why it fails'])).toBe(false)
  })
  test('a new prompt is not matched', async () => {
    expect(wasSentBefore('um check the signup page', sent, 'run the tests', ['fix it'])).toBe(false)
  })
})

describe('edges', () => {
  test('kept blocks at the start and end are split off with their spacing', async () => {
    expect(edges('\n\n[kept block 1]\n\n um say this [kept block 2] ok [kept block 3]\n')).toEqual({
      head: '\n\n[kept block 1]\n\n ',
      body: 'um say this [kept block 2] ok',
      tail: ' [kept block 3]\n',
    })
  })
  test('no kept blocks: all body', async () => {
    expect(edges('just speech')).toEqual({ head: '', body: 'just speech', tail: '' })
  })
  test('restore refuses markers out of order', async () => {
    expect(restore('[kept block 2] [kept block 1]', ['a', 'b'])).toBe(null)
  })
})
