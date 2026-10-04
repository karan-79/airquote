# Airquote

**Talk to Claude Code. Airquote makes what you said read like what you meant.**

Claude Code's voice mode (`/voice`) types exactly what you say, including every "um", false start and change of mind. Airquote notices which prompts you spoke and has a fast Claude model (Haiku by default) clean them up before Claude reads them. Prompts you type are never touched.

| You say | Claude gets |
|---|---|
| *"um so can you uh check why the, the login page is slow, no wait, the signup page, on mobile"* | Can you check why the signup page is slow on mobile? |

By default, your original words are also passed to Claude as hidden context, so a rewrite can never lose what you said.

## Install

Run these two commands inside Claude Code:

```
/plugin marketplace add karan-79/airquote
/plugin install airquote@airquote
```

Then turn on voice mode and talk as usual:

- `/voice hold`: hold the space bar while you speak, release, and press Enter to send.
- `/voice tap`: tap space to start, tap again to stop and send.

Airquote works with both. You don't need an API key or another app: it uses the voice mode and Claude login you already have.

## Configure

Airquote works out of the box. These six settings let you tune it:

| Setting | Default | What it does |
|---|---|---|
| **Rewrite mode** (`mode`) | `enhance` | `clean`: fixes the writing only: removes filler, fixes punctuation, applies your mid-sentence corrections. Your words, order and tone stay.<br>`enhance`: the same clean-up, then lays it out for easier reading (sentences, paragraphs, a list if you clearly listed things), using only your own words. If a dictation is too unclear to lay out without guessing, it is only cleaned up and you see a short message.<br>`off`: no rewrite. Claude is still told the prompt was spoken. |
| **Rewrite model** (`model`) | `haiku` | The model that rewrites your dictation: `haiku`, `sonnet` or `opus`. Haiku is fastest. Sonnet and Opus can follow your extra instructions more closely, but each spoken prompt takes several seconds longer and uses more of your plan's usage. |
| **Personal dictionary** (`dictionary`) | empty | Words to always spell exactly, separated by commas. Example: `Kubernetes, Tailwind, Acme Cloud` |
| **Extra rewrite instructions** (`instructions`) | empty | Your own rules for the rewrite. Example: `Keep my casual tone. Use British English.` |
| **Attach original transcript** (`attach_transcript`) | on | When a prompt is rewritten, Claude also gets your exact dictated words as hidden context, so a bad rewrite can't lose your meaning. Turn it off and Claude sees only the rewrite. |
| **Share repo and conversation context** (`share_context`) | on | Lets the rewrite model see your repo's file names and the last few messages, so names and words like "that bug" come out right. Turn it off to share less (see [Privacy](#privacy)). |

### How to change a setting

Pick whichever way you like. All three change the same settings.

**1. In Claude Code (easiest)**

Run `/config`, scroll to the **Airquote** rows, and change a value. It takes effect immediately.

Or run `/plugin configure airquote@airquote` to edit all settings in one form.

**2. Switch the mode with one command**

```
/airquote enhance
/airquote clean
/airquote off
```

**3. From your shell**

Pass the settings you want to change as JSON. Settings you leave out keep their values.

```sh
echo '{"mode": "clean", "model": "sonnet", "dictionary": "Kubernetes, Tailwind"}' \
  | claude plugin configure airquote@airquote --values-stdin
```

Write every value as a string, including on/off: `"share_context": "false"`. Restart Claude Code afterwards.

To see your current values from the shell, run `claude plugin configure airquote@airquote`.

### Check what Airquote did

Run `/airquote` in Claude Code. It shows your current mode and what happened to your last 10 prompts, for example `typed`, `voice, enhance` or `voice, kept as spoken`.

## How Airquote knows you spoke

Voice mode doesn't tell plugins where text came from, so Airquote watches the prompt box:

| You dictate with | How Airquote knows |
|---|---|
| Hold space (`/voice hold`) | The hint under the prompt box says "keep holding…" while you record. |
| Tap space (`/voice tap`) | The text appears in an empty box without a single key press. |
| Voice and typing mixed | Four or more words appear that you didn't type or paste. |

When Airquote isn't sure, it treats the prompt as typed and leaves it alone. Every prompt it recognizes as spoken carries a hidden note telling Claude it was dictated, even when nothing is rewritten.

## Privacy

Airquote makes **one model call per spoken prompt**, to the rewrite model you chose (Claude Haiku by default), through Claude Code's own connection (your existing Claude login). It contacts no other service, writes no files and keeps no logs.

That call contains:

- the prompt you spoke
- your personal dictionary and extra rewrite instructions, if set
- only while **Share repo and conversation context** is on (the default):
  - your repository's file list, from `git ls-files` (up to about 12,000 characters)
  - the last 4 messages of the conversation (up to 600 characters each)

`git ls-files` is the only command Airquote runs. Turn **Share repo and conversation context** off and the rewrite model sees only your prompt, your dictionary and your instructions.

## Good to know

- **Tap mode sends right away.** The second tap sends the prompt, so you can't review the rewrite first. In hold mode you can edit the raw text before pressing Enter, but the rewrite still happens on send.
- **Spoken prompts take a little longer** while they are rewritten: about 1–3 seconds with Haiku, more with Sonnet or Opus. A rewrite that takes too long is skipped and your original words are sent.
- **Short dictations stay short.** Under 4 words, nothing is rewritten. Under 12 words, `enhance` only cleans.
- **It never guesses what you meant.** "it", "this plugin" or a word it doesn't know stays as you said it; Claude, which has the whole conversation, works out the meaning. Add project names to your dictionary to get them spelled right.
- **If the rewrite fails or misunderstands**, your original words go through (on a failure) or are still there for Claude (on a bad rewrite). Use `clean` mode if you prefer your own phrasing.
- **Hold-mode detection relies on the "keep holding…" hint.** If a future Claude Code version changes that text, Airquote falls back to the word check.

## Compatibility

- **Tested on:** the Claude Code CLI 2.1.288 on Linux.
- **Requires:** Claude Code 2.1.271 or later (plugin settings with fixed choices need it).
- **Desktop app and other systems:** should work; not yet tested. The IDE extensions don't show the hint line Airquote uses for hold mode, so there it relies on the word check.
- **Cloud sessions and headless runs** (`claude -p`, the Agent SDK): not supported. Airquote only acts on prompts you send from the prompt box.

Airquote is a mod, and mods are an early-access part of Claude Code. If an update changes how voice mode behaves, Airquote treats your spoken prompts as typed and leaves them alone until it is updated.

## Development

The code is in `hooks/`:

- `register.ts`: the hooks that connect Airquote to Claude Code
- `rewrite.ts`: the detection rules and the instructions sent to the rewrite model
- `rewrite.test.ts` and `flow.test.ts`: tests for the rules, and end-to-end tests that drive the real hooks (typed, tap and hold prompts, failed rewrites, every setting)

```sh
claude plugin validate .   # check the plugin
claude plugin test .       # run the tests
claude --plugin-dir .      # try it in a session
```

## License

[MIT](LICENSE)
