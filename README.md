# Airquote

**Talk to Claude Code. Airquote makes what you said read like what you meant.**

Claude Code's voice mode (`/voice`) types exactly what you say, including every "um", false start and change of mind. Airquote notices which prompts you spoke and has a fast Claude model (Haiku by default) clean them up before Claude reads them. Prompts you type are left alone.

| You say | Claude gets |
|---|---|
| *"um so can you uh check why the, the login page is slow, no wait, the signup page, on mobile"* | Can you check why the signup page is slow on mobile? |

By default, Claude also gets your original words as hidden context, so it can check the rewrite against what you said.

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

To get a newer version later, run `/plugin update airquote@airquote`.

## Configure

| Setting | Default | What it does |
|---|---|---|
| **Rewrite mode** (`mode`) | `enhance` | `clean`: removes filler, fixes punctuation and applies your mid-sentence corrections. Your words, order and tone stay.<br>`enhance`: the same, then lays it out for easier reading (sentences, paragraphs, a list if you clearly listed things), using only your own words. If a dictation is too unclear to lay out, it is only cleaned and you see a short message.<br>`off`: no rewrite. Claude is still told the prompt was spoken. |
| **Rewrite model** (`model`) | `haiku` | `haiku`, `sonnet` or `opus`. Haiku is fastest. Sonnet and Opus are slower and use more of your plan's usage. |
| **Personal dictionary** (`dictionary`) | empty | Words to always spell exactly, separated by commas. Example: `Kubernetes, Tailwind, Acme Cloud` |
| **Extra rewrite instructions** (`instructions`) | empty | Your own rules for the style of the rewrite. Example: `Keep my casual tone. Use British English.` They can't add, drop or change what you said. |
| **Attach original transcript** (`attach_transcript`) | on | When a prompt is rewritten, Claude also gets your exact dictated words as hidden context. Off: Claude sees only the rewrite. |
| **Share repo and conversation context** (`share_context`) | on | Lets the rewrite model see your repo's file names and the last few messages, so names come out right. Off: it sees only your words, dictionary and instructions. |

### How to change a setting

- **In Claude Code:** run `/config` and change the **Airquote** rows, or run `/plugin configure airquote@airquote` to edit them all in one form.
- **Mode only:** `/airquote enhance`, `/airquote clean` or `/airquote off`.
- **From your shell:** pass the settings to change as JSON, every value as a string. Settings you leave out keep their values. Restart Claude Code afterwards.

  ```sh
  echo '{"mode": "clean", "share_context": "false"}' \
    | claude plugin configure airquote@airquote --values-stdin
  ```

### Check what Airquote did

Run `/airquote`. It shows your mode and what happened to your last 10 prompts, for example `typed`, `voice, enhance` or `voice, kept as spoken`.

## How it works

Voice mode doesn't tell plugins where text came from, so Airquote watches the prompt box:

| You dictate with | How Airquote knows |
|---|---|
| Hold space | The hint under the prompt box says "keep holding…" while you record. |
| Tap space | Text appears and is sent without a single key press. |
| Voice and typing mixed | Four or more words appear that you didn't type. |

When Airquote isn't sure, it treats the prompt as typed. A prompt it recognizes as spoken gets a hidden note telling Claude it was dictated, even when nothing is rewritten.

- **Only your spoken words are rewritten.** Pastes, text in backticks and `@file` mentions go to Claude exactly as they were, in the same place, and the rewrite model never sees them. A prompt that is only a paste counts as typed.
- **Slash commands and `!` shell commands** are never touched.
- **Short dictations:** under 4 words, nothing is rewritten. Under 12 words, `enhance` only cleans.
- **It doesn't guess what you meant.** "it", "this plugin" or a word it doesn't know stays as you said it. Add project names to your dictionary to get them spelled right.
- **If the rewrite fails or takes too long**, your original words are sent.
- **Recalling a dictation from this session** with Up-arrow or Ctrl+R sends the cleanup Airquote made the first time.
- **Tap mode sends right away**, so you can't review the rewrite first.

## Known limits

- **Terminal only.** Airquote works in Claude Code in your terminal (the CLI). In the desktop app and IDE extensions it does nothing, because only the terminal tells it which keys you pressed.
- **Tap mode is detected by elimination.** A few keyboard actions also put text in the box without a key press. Airquote recognizes prompts recalled from this session (Up-arrow, Ctrl+R, rewind) and an accepted suggestion (Tab), and leaves them alone. These can still be taken for speech and cleaned: a prompt from an earlier session recalled with Up-arrow or Ctrl+R, text written with the Ctrl+G editor into an empty box, a Ctrl+S stash coming back, and undo right after clearing the box.
- **Hold mode relies on the "keep holding…" hint.** If Claude Code changes that text, Airquote falls back to the four-word check.

## What Airquote reads, sends and changes

- **Reads:** your edits in the prompt box and each prompt you send, the hint line under the box, and the conversation's messages (to recognize prompts you recall; they're only sent anywhere as described below).
- **Sends:** one model call per spoken prompt, to the rewrite model you chose, through Claude Code's own model call (so it goes to Anthropic, like the rest of your session). It contains your spoken words (not your pastes, code or file mentions), your dictionary and extra instructions, and, while **Share repo and conversation context** is on, your repository's file list (up to about 12,000 characters) and the last 4 messages (up to 600 characters each). Airquote contacts nothing else.
- **Runs:** `git ls-files`, to get your repository's file names so names come out spelled right. It's the only program Airquote runs, and only while **Share repo and conversation context** is on.
- **Changes:** the text of a spoken prompt, replaced with its cleanup before Claude reads it, plus hidden notes for Claude saying it was spoken (and, by default, your original words). Typed prompts aren't changed.
- **Sets:** `/airquote enhance|clean|off` saves the **Rewrite mode** setting, the same as changing it in `/config`. Airquote changes no other setting.
- **Keeps:** the prompts you sent this session and their cleanups, in Claude Code's memory for the session, to recognize prompts you recall. Nothing is written to disk.
- **Adds:** the `/airquote` command, which shows the mode and what happened to your last 10 prompts, or sets the mode.

## Development

- `hooks/register.ts`: the hooks that connect Airquote to Claude Code
- `hooks/rewrite.ts`: the detection rules and the instructions sent to the rewrite model
- `hooks/*.test.ts`: tests for the rules, and end-to-end tests that drive the real hooks
- `types/airquote.d.ts`: what Airquote keeps in the session

```sh
claude plugin validate .   # check the plugin
claude plugin test .       # run the tests
claude --plugin-dir .      # try it in a session
```

## License

[MIT](LICENSE)
