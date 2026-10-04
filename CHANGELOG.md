# Changelog

## 0.1.0 (2026-10-04)

First release.

- Detects dictated prompts: the hold-to-talk hint, a box filled with no keystrokes (tap), or untyped words.
- Rewrites them with Haiku in `enhance` (default) or `clean` mode; `off` only marks them as spoken.
- Claude gets the raw transcript and a "dictated with voice mode" note as hidden context.
- Settings in `/config`: mode, personal dictionary, extra rewrite instructions, and whether to share repo/conversation context.
- `/saywright` shows the mode and recent decisions; `/saywright <mode>` switches mode.
