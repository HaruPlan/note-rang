<p align="center">
<img src="../logo.png" alt="Note Rang logo" width="180" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows" />
</p>

<p align="center">
<b>Note Rang - floating markdown sticky notes</b>
</p>

<p align="center">
<img src="https://img.shields.io/badge/Multi%20Floating%20Windows-449300?style=flat-square" alt="Multi floating windows" />
<img src="https://img.shields.io/badge/Multi%20Pointer-449300?style=flat-square" alt="Multi pointer" />
<img src="https://img.shields.io/badge/Markdown-449300?style=flat-square" alt="Markdown" />
<img src="https://img.shields.io/badge/Plugins-449300?style=flat-square" alt="Plugins" />
</p>

<p align="center">
  <sub><a href="../README.md">한국어</a></sub>
</p>

## Highlights

- **Floating note windows** — one note is one window (borderless). Shrink it
  vertically and it collapses to just the title row.
- **Live markdown preview** — styling is applied in place, the source text stays
  as you typed it.
- **Selection formatting bar** — select text and a floating bar appears next to
  it (bold, italic, strikethrough, code, highlight, link, color). It does not
  care how you selected: mouse drag or `Shift`+arrows / `Mod-A` both work.
- **Note list & search panel** — favorites pin to the top, and the list sorts by
  date added, last modified, title, character count, or most recently opened
  (the choice is stored per device).
- **Toolbar layout** — drag buttons into the four zones of the top and bottom
  bars, and put away the ones you never use. Plugin buttons live in the same
  editor.
- **Themes and colors** — pick a theme and edit its color tokens. The note list
  & search window gets its own background and text color.
- **Startup behavior** — launching the app yourself opens the note list (login
  item autostart does not). Choose whether an empty vault opens the list or a
  new note.
- **Getting-started note** — a starter guide note is created automatically on
  first launch (reopen it anytime from Settings › Help).
- **Shortcuts and tray** — assign OS-global shortcuts to actions such as "new
  note", and drive the app from the menu bar (tray).
- **Vault, backup, recovery** — notes are plain markdown files in a folder you
  choose. Settings and plugins export to a backup file you can restore, and
  notes saved by overwrite can be recovered from their previous body.
- **Plugins** — much of the feature surface is plugins, and you can write your
  own (table below · [authoring guide](plugin/authoring.md), Korean).

## Bundled plugins

| Category            | Plugin                                                         | What it does                                                   |
| ------------------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Window & display    | [Always on Top](../src/plugin/builtin/plugins/always-on-top)   | Pin the note window above other windows                        |
| Window & display    | [All Desktops](../src/plugin/builtin/plugins/all-desktops)     | Show the note on every macOS Space                             |
| Window & display    | [Transparency](../src/plugin/builtin/plugins/transparency)     | Adjust note window transparency (macOS)                        |
| Window & display    | [Background](../src/plugin/builtin/plugins/background)         | Per-note background color with readable text color             |
| Window & display    | [Font Scale](../src/plugin/builtin/plugins/font-scale)         | Per-note font size                                             |
| Window & display    | [Font](../src/plugin/builtin/plugins/font)                     | Choose system/installed fonts                                  |
| Window & display    | [Reset Options](../src/plugin/builtin/plugins/reset-options)   | Restore per-note display options to the global defaults        |
| Editing             | [Template](../src/plugin/builtin/plugins/template)             | Save/insert templates with date & cursor variable substitution |
| Editing             | [Duplicate](../src/plugin/builtin/plugins/duplicate)           | Duplicate the body and per-note settings into a new note       |
| Editing             | [Copy AI Prompt](../src/plugin/builtin/plugins/copy-ai-prompt) | Combine your phrase and note content, copy to clipboard        |
| Editing             | [Word Count](../src/plugin/builtin/plugins/word-count)         | Live word/character count and copy                             |
| Markdown extensions | [Highlight](../src/plugin/builtin/plugins/highlight)           | `==text==` highlight                                           |
| Markdown extensions | [Text Color](../src/plugin/builtin/plugins/text-color)         | `{{text\|#f36}}` colors the text                               |
| Markdown extensions | [Spoiler](../src/plugin/builtin/plugins/spoiler)               | `\|\|text\|\|` hidden until revealed                           |
| Markdown extensions | [Underline](../src/plugin/builtin/plugins/underline)           | `++text++` underline                                           |
| Markdown extensions | [Superscript](../src/plugin/builtin/plugins/superscript)       | `^text^` superscript                                           |
| Markdown extensions | [Kbd](../src/plugin/builtin/plugins/kbd)                       | `{{Cmd+C}}` keycap notation                                    |
| Links & embeds      | [Wikilink](../src/plugin/builtin/plugins/wikilink)             | Link and autocomplete other notes with `[[Title]]`             |
| Links & embeds      | [YouTube Embed](../src/plugin/builtin/plugins/youtube-embed)   | Render links inside `youtube` code blocks as a player          |

### Language

Korean and English ship built in (no install step, auto-selected from the OS
language). Switch anytime from the language dropdown in **Settings ›
Appearance › Theme**, and other languages can be added by building your own
from the [language pack plugin](plugin/examples/language-pack-en/) template.

## Install

### Mac OS

```bash
brew install --cask haruplan/tap/note-rang
```

Install this tap only if you trust the publisher.

### Windows

A Windows installer (`.exe`) ships with every release too.

> Unsigned builds may trigger a SmartScreen warning — choose "More info → Run anyway" to install anyway.

## Contributing

The dev environment, quality gates, build/release, architecture and data
layout are covered in [CONTRIBUTING.md](../CONTRIBUTING.md). Style
conventions live in [contributing/style.md](contributing/style.md); the full
doc index is [README.md](README.md).
