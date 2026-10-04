# Saywright

Speak your prompts to Claude Code and have them arrive clean.

Saywright is a Claude Code plugin (a [mod](https://code.claude.com/docs/en/plugins/mods/overview)) for the built-in voice mode (`/voice`). It works out which prompts you dictated and which you typed. A dictated prompt goes to Claude Haiku first, which removes filler words ("um", "uh", "you know"), applies your self-corrections ("use X, no wait, Y" becomes "use Y"), fixes punctuation, and spells project names and files correctly. In **enhance** mode it also restructures the prompt so the main ask comes first and several asks become a short list. Typed prompts are never touched.

Claude still receives your raw transcript as hidden context, so a rewrite can't silently lose what you said.

## Install

```
/plugin marketplace add karan-79/saywright
/plugin install saywright@saywright
```

Then turn on voice mode with `/voice hold` or `/voice tap` and dictate as usual.

## How it tells voice from typing

Voice mode doesn't tell plugins where text came from, so Saywright watches what happens in the prompt box:

| You dictate with | Detected by |
|---|---|
| Hold space (`/voice hold`) | The hint line under the prompt shows "keep holding…" while recording |
| Tap space (`/voice tap`) | Text arrives in an empty box without a single keystroke |
| Dictation mixed with typing | Four or more words arrive that you didn't type or paste |

Prompts it can't place, such as one you were typing while the plugin reloaded, are treated as typed and left alone.

Every prompt detected as voice carries a hidden note telling Claude it was spoken, even when it isn't rewritten.

## Modes and settings

Set these in `/config` (the Saywright rows), or switch the mode with a command:

- `/saywright` shows the current mode and what happened to your last few prompts.
- `/saywright enhance` cleans up and restructures. This is the default. Dictations under 12 words are only cleaned, so short remarks don't get padded.
- `/saywright clean` fixes filler, punctuation and self-corrections and keeps your wording.
- `/saywright off` never rewrites, but Claude is still told the prompt was spoken.

The other settings:

- **Personal dictionary**: comma-separated terms to spell exactly, such as project names, people and libraries.
- **Share repo and conversation context**: on by default. See below.

## What it sends, and where

Saywright makes one model call per dictated prompt, through Claude Code's own model client: your existing Claude login, model `haiku`. It contacts no other service, stores no files and keeps no logs on disk.

That call contains:

- the dictated prompt
- your personal dictionary
- if **Share repo and conversation context** is on (the default):
  - the file list of the current git repository (`git ls-files`, up to about 12,000 characters)
  - the text of the last 4 messages in the conversation, each cut to 600 characters

The repo file list and recent messages help Haiku spell file names and resolve words like "that" or "the bug". Turn the setting off to send only the dictation and dictionary.

To get the file list, Saywright runs `git ls-files` in the session's working directory. That is the only command it runs.

## Limits

- **Rewrites happen as the prompt is sent.** In tap mode, the second tap sends right away. In hold mode you can review the raw transcript before pressing Enter, but not the rewrite.
- **Rewriting adds about 1–3 seconds** to dictated prompts.
- **Enhance mode can still misjudge your intent.** That's why Claude also gets the raw transcript. Use `clean` if you prefer your own wording.
- **Detection relies on what Claude Code's voice mode currently shows.** If a future version changes the hint text, hold mode falls back to the word-count check.

## Development

The plugin is three TypeScript files in `hooks/`: `register.ts` (the hooks), `rewrite.ts` (pure logic and prompts) and `rewrite.test.ts`.

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # try it in a session
```

## License

[MIT](LICENSE)
