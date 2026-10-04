// What Airquote keeps in the session through `$.state`, so a reload of the
// plugin (a /airquote or /config change) doesn't forget it.

// Prompts sent this session (as typed or spoken, and as rewritten), as
// `promptKey` makes them; the suggestion last shown; and the latest rewrites,
// so a dictation recalled from history goes as it was cleaned before.
export type AirquoteRecall = {
  sent: string[]
  suggestion: string
  rewrites?: { from: string; to: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    airquote: { recall: AirquoteRecall }
  }
}
