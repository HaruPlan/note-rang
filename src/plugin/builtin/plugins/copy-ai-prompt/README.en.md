Copies the note you're viewing to the clipboard, wrapped in a template you define. Great for building a prompt to paste into an AI chat.

## How to use

- Write your "Copy template" in **Settings › Tools › Copy** first (see the variables below).
- Press the 📋 button on the note toolbar → it's copied with the template filled in, and a "Copied" toast appears. Paste it anywhere (Cmd+V / Ctrl+V).
- Put the variables below in the copy template and they're automatically filled with the current note's values:

| Variable    | Filled with                        |
| ----------- | ---------------------------------- |
| `{content}` | The full note body                 |
| `{path}`    | The path the note file is saved at |

- For example, set the template to `Summarize this note: {content}` and one press copies "summarize + my note" together.

## What you can change

- **Copy template** — mix the variables above into whatever shape you want. Leave it empty and only the note path is copied. Use a known variable like `{path}`/`{content}` and a live preview appears right under the input, so you can check the result without opening a note window.

> "Copy using template" can also be bound to a key combination in **Settings › Shortcuts**.

> Where the 📋 button sits is decided by dragging it in **Settings › Appearance › Toolbar Layout**.
