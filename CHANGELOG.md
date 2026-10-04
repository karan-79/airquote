# Changelog

## 0.1.0 (2026-10-04)

First release.

- Detects dictated prompts: the hold-to-talk hint, a box filled with no keystrokes (tap), or untyped words.
- Rewrites them with Haiku in `enhance` (default) or `clean` mode; `off` only marks them as spoken.
- Claude gets the raw transcript and a "dictated with voice mode" note as hidden context.
- Settings in `/config`: mode, rewrite model (`haiku` default, `sonnet`, `opus`; larger models get a longer time limit), personal dictionary, extra rewrite instructions, and whether to share repo/conversation context.
- `/airquote` shows the mode and recent decisions; `/airquote <mode>` switches mode.
