# Example: language pack template (`contributes.translations` — declarative-only)

English now ships as a **bundled language pack**
(`src/plugin/builtin/language-packs/language-pack-en/`, issue #30) — this
folder is no longer that source. It now stays as a **minimal template showing
how to build a declarative-only language pack**. To keep it small, `entries`
holds only 5 representative keys (no placeholder / one placeholder / several
placeholders) — a real language pack needs every key `src/i18n/ko.json` has
(see "Building your own language pack" below).

**This folder is a documentation-only template** — no test uses it as a fixture
(the e2e suite carries its own). Its single job is to show humans and AIs what a
language pack manifest looks like.

Language packs have **no runtime registration API**. The manifest's
`contributes.translations` is the entire contract, which also makes this the
repository's only "declarative-only (no main.js code)" example.

## What this example demonstrates

- **A language pack is a capability.** It is only collected with
  `kind: "capability"` + `permissions: ["i18n"]` — the same gate as themes,
  backgrounds, fonts, and window controls. Getting it wrong raises **no error**,
  though: this declaration is read by the core (Rust), not by the bridge
  gatekeeper, and an unqualified plugin is simply skipped. That is why the
  `lint` in step 5 below is your real safety net.
- **main.js is a single whitespace character (one newline).** If everything you
  register lives in the manifest, there is no reason to run JS. The `entry`
  field itself is required so the file must exist (an empty string gets the
  whole plugin dropped by the scan — it can't be told apart from a failed file
  read), but when the content is **whitespace-only** the host never spins up
  this plugin's sandbox (iframe) at all (see the `contributes` description in
  `docs/plugin/manifest.schema.json` and the `code.trim() === ""` branch in
  `src/plugin/central-host.ts`). A comments-only file is not "whitespace-only",
  so it doesn't get this optimization — the check is a shallow trim.
- **Neither the host nor a sandbox ever touches this data.** The core
  (`src-tauri/src/plugin_i18n.rs`) scans installed manifests directly and feeds
  each window — which is why a window comes up in your language **before** its
  first paint (it used to round-trip through the host, painting Korean once and
  then reloading). The source of truth for item shape (`locale` · `label` ·
  `entries` · the 256KB cap) is `parse_translation` in that file.
- **Content validation happens at consumption time (in each window), not at
  collection.** Each key in `entries` is checked against that window's ko
  dictionary: (1) keys unknown to ko are silently dropped, and (2) a key whose
  `{placeholder}` set differs from the ko sentence is rejected alone
  (`src/i18n/validate.ts`) — one mistake in a language pack never blocks the
  whole load.
- **`ko` and the codes bundled packs register (`en`) can't be registered by a
  third-party language pack.** This example's `locale` is still `"en"`, but
  installing and activating it in the real app changes nothing —
  `src/i18n/store.ts`'s `registerLocale` silently ignores protected codes (ko
  from the start as the base language, `en` the moment the bundled pack
  registers it), so a third party can't silently replace the app's own
  translations. This folder is purely a **structural reference**.

## Building your own language pack

1. Copy this folder wholesale and change `id` and `name` in `manifest.json`
   (keep the folder name equal to `id`). Also change `locale` to your target
   language (anything other than `en`) — e.g. `"fr"` for French.
2. Fill `entries` using `src/i18n/ko.json` as the source — **keep the keys as
   they are**, translate only the values. This example's 5 keys are just a
   starting point; a real pack needs every key `ko.json` has for 100% coverage
   (a complete one: `src/plugin/builtin/language-packs/language-pack-en/manifest.json`,
   which has exactly this folder's shape filled out at full size).
   - `{name}`-style placeholders must match **exactly**, name included (order
     doesn't matter). One typo or omission drops that key alone; the rest
     survive.
   - Keys that don't exist in ko are ignored — your target is every key ko has.
   - Korean-only conventions like the dual particle notation (`…을(를)`) should
     be rewritten into your language's natural word order.
3. `locale` only accepts lowercase simple BCP47 (`en` · `en-us` · `pt-br`).
   `label` is the display name shown in the language dropdown (must not be
   empty).
4. If you truly have no JS to run, keep the file `entry` points to as
   **whitespace only (a single newline)** — then no sandbox is created. If you
   want an init log, a minimal script calling `memo.runtime.ready()` works too
   (which of course does create the sandbox).
5. From the repository root, check with `npm run plugin -- lint <folder>` —
   per-item validity of `entries` is a runtime, consumption-time check (against
   ko), so lint can't catch it for you. The source of truth is launching the
   app and switching the language dropdown in **Settings › Appearance › Theme**
   to see the UI actually render in your language.

For the full contract see `contributes.translations` in
[`../../manifest.schema.json`](../../manifest.schema.json); for the
human-readable description see the "언어팩" section of
[`../../authoring.md`](../../authoring.md). The UI string conventions (key
format, particle notation, fallback chain) live in
[`../../../contributing/i18n.md`](../../../contributing/i18n.md).
