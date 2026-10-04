import { describe, expect, test } from 'claude-code/testing'

import {
  asMode,
  asModel,
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
