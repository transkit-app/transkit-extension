# Developer Guide

This guide gives an overview of TransKit's technical architecture to help developers understand how the extension works.

## Architecture Overview

TransKit is a **Chrome Extension Manifest V3** written in plain JavaScript, HTML and CSS. There is **no build step**: the `extension/` directory is loaded into Chrome as-is. Node is only used for linting.

The extension has four runtime parts:

1.  **Content scripts** (`extension/src/content-script-granularity.js`, `extension/src/content-script.js`)
    - Run in every page and frame (`<all_urls>`, `all_frames: true`) as classic scripts that share one isolated world. `content-script-granularity.js` loads first and provides the line/sentence helpers used by hover translate.
    - Detect the `!!<lang>` command, run Instant mode, Select-to-Translate and Hover translate.
    - Render all floating UI inside the [isolated UI overlay](#isolated-ui-overlay).
    - Content scripts cannot use static `import`. Modules (`language-map.js`, `i18n.js`, `tts.js`) are loaded at bootstrap with `import(chrome.runtime.getURL(...))` inside a try/catch.

2.  **Background service worker** (`extension/src/background.js`, ES module)
    - The messaging hub: settings storage, translation routing, offscreen document lifecycle, TTS forwarding.
    - Translates through `AIProviderService` (`services/ai-providers.js`). HTML input is converted to Markdown before translation and back afterwards (`services/format-utils.js`).

3.  **Offscreen document** (`extension/src/offscreen.js`, `extension/pages/offscreen.html`)
    - Runs Chrome's built-in `Translator` and `LanguageDetector` APIs, which need a DOM context that the service worker lacks.
    - Plays TTS audio.

4.  **Popup / options page** (`extension/src/popup.js`, `extension/pages/popup.html`)
    - The same page serves as the toolbar popup and as the options page (opened in a tab).

## Features and Flows

### Manual mode (`!!<lang>`)

1.  The user types `Hello !!es` (or `!!t` for the default target, or an alias) in an editable field.
2.  `content-script.js` matches `TRANSLATION_COMMAND_PATTERN` and sends `translate` to the background.
3.  The background translates with the active provider (via the offscreen document for Chrome Built-in AI).
4.  If `showConfirmModal` is on, an inline suggestion appears under the field: **Tab** applies it, **Esc** dismisses it. Otherwise the text is replaced directly.

### Instant mode

1.  Enabled per domain (`instantDomains`). `Ctrl/Cmd+Shift+I` toggles the current domain and adds it if missing.
2.  A small "Instant" label appears above a focused field.
3.  After the user stops typing for `instantDelay` ms, the text is translated (native → target).
4.  An inline suggestion appears with a model switcher. **Tab** applies it. **Esc**, **Backspace/Delete**, typing again or clicking outside dismisses it.

### Select-to-Translate

1.  Selecting text shows a TransKit icon. Clicking it opens a draggable popup with source/target language selectors, provider selector, TTS and copy buttons.
2.  The original text is an editable textarea. Edits re-translate 600 ms after typing stops, **Enter** translates immediately, **Shift+Enter** inserts a newline. Enter during IME composition is ignored.
3.  **Pin**: a pinned popup ignores outside clicks (only × closes it) and automatically loads every new page selection in place.
4.  The last used source/target languages are saved as `selectionLastSource` / `selectionLastTarget`.

### Hover translate

1.  Enabled per domain (`hoverTranslateDomains`). `Ctrl/Cmd+Shift+O` toggles the current domain.
2.  Holding the modifier key (`hoverModifierKey`) over a paragraph translates it, line by line or sentence by sentence (`hoverTranslateGranularity`).
3.  The translation is **injected into the page content** below the original (`inject`, styled by `hover-translate.css` and `hoverInjectStyle`) or replaces it (`replace`). Unlike the floating UI, this is intentionally part of the page.

## Isolated UI Overlay

All floating UI (selection icon and popup, inline suggestion, toasts, Instant label) is rendered inside a single overlay so host-page CSS cannot restyle or shift it:

-   A custom `<transkit-overlay>` element is appended to `document.documentElement`. A custom tag means generic page selectors (`div`, `span`, ...) never match it. Its layout is set with inline `!important` styles, which beat any author rule.
-   The host has a **closed Shadow DOM**, so page CSS cannot reach the UI.
-   The host is promoted to the **top layer** with the Popover API (`popover="manual"`), so page `transform`, `z-index` and `overflow` cannot hide or offset it. `bringOverlayToFront()` re-shows it above top-layer elements the page opened later, but not while focus is inside it (that would pull focus out of the popup's textarea).
-   Styles (`tokens.css`, `dialogs.css`, `inline-suggestion.css`, `selection.css`) are fetched once, preloaded at bootstrap, and injected as a `<style>` in the shadow root. `@import` lines are stripped, and **`rem` values are converted to `px`**, because `rem` follows the page's `<html>` font-size even inside Shadow DOM (many sites use `html { font-size: 62.5% }`).
-   `getOverlayRoot()` creates the overlay on demand (synchronously). `removeOverlayIfEmpty()` removes the host once no UI is left.

Rules when adding floating UI:

-   Append it to `getOverlayRoot()`, never to `document.body`. Remove it with `element.remove()` followed by `removeOverlayIfEmpty()`.
-   Add its stylesheet to `OVERLAY_STYLESHEETS`, not to the manifest's `content_scripts.css` (that CSS is injected into every page globally).
-   Element `class` attributes are invisible to page-level code. From a document listener, `e.target` is the host, so use `isEventFromOverlay(e)` to recognize events from the overlay.
-   Key events from the overlay are stopped at the window (capture phase) so page shortcuts (YouTube `k`, Gmail `c`, ...) and TransKit's own field handlers do not see typing in the popup.
-   Set user text and model output with `textContent` / `.value`, never by interpolating into `innerHTML`.

## Messaging

| Message | Sender → receiver | Purpose |
| --- | --- | --- |
| `ping` | any → background | Health check |
| `get-settings` | any → background | Read settings |
| `set-settings` | popup page, domain toggles → background | **Replace** the whole settings object |
| `update-settings` | content script → background | **Merge** a `patch` into the latest stored settings (serialized) |
| `translate` | content script → background | Translate text with the active or a given `providerId` |
| `offscreen-translate` | background → offscreen | Translate with Chrome Built-in AI |
| `tts-play` / `play-tts` | content script → background → offscreen | Play TTS audio |
| `open-options` | content script → background | Open the options page |

Use `update-settings` when you hold a settings object that may be stale (for example one fetched when a popup opened). Writing it back with `set-settings` would revert changes made elsewhere in the meantime.

## Settings

Settings are stored in `chrome.storage.local` under the key `translatorSettings`. Defaults live in `readSettings()` in `background.js`. Content scripts read them with `getSettings()` and watch `chrome.storage.onChanged` where they cache them.

## Translation Providers

`services/ai-providers.js` defines a `TranslationProvider` base class with one subclass per provider. `AIProviderService.getProvider()` maps the provider `type` from settings to a class:

| `type` | Class |
| --- | --- |
| `gemini-nano` (default, `builtin`) | `WindowAIProvider`: signals the background to use the offscreen document |
| `gemini` | `GeminiProvider` |
| `openai` | `OpenAIProvider` |
| `openrouter` | `OpenRouterProvider` |
| `deepl` | `DeepLProvider` |
| `google-translate` | `GoogleTranslateProvider` |
| `groq` | `GroqProvider` |
| `ollama`, `custom` | `CustomProvider` (OpenAI-compatible endpoint) |

To add a provider, subclass `TranslationProvider`, implement `async translate(text, sourceLang, targetLang)`, add a `case` in `getProvider()`, and add its configuration UI in the popup page. LLM providers use `DEFAULT_SYSTEM_PROMPT` or the user's `customPrompt`.

## File Structure

```
transkit-extension/
├── extension/                       # The unpacked extension (load this directory)
│   ├── manifest.json
│   ├── pages/
│   │   ├── popup.html               # Toolbar popup and options page
│   │   └── offscreen.html           # Offscreen document
│   ├── src/
│   │   ├── background.js            # Service worker: messaging, settings, routing
│   │   ├── content-script.js        # Manual, Instant, Select-to-Translate, Hover, overlay
│   │   ├── content-script-granularity.js  # Line/sentence helpers for hover translate
│   │   ├── offscreen.js             # Built-in Translator/LanguageDetector, TTS audio
│   │   ├── popup.js                 # Popup/options UI
│   │   ├── services/
│   │   │   ├── ai-providers.js      # Provider classes and AIProviderService
│   │   │   ├── format-utils.js      # HTML <-> Markdown conversion
│   │   │   └── tts.js               # TTS client
│   │   └── common/
│   │       ├── language-map.js      # Language name/code normalization
│   │       ├── i18n.js              # I18n class and shared instance
│   │       └── locales.js           # UI strings (en, vi)
│   └── assets/
│       ├── styles/
│       │   ├── tokens.css           # Design tokens (--bt-*)
│       │   ├── common.css           # Shared button styles (popup page)
│       │   ├── popup.css            # Popup/options page
│       │   ├── dialogs.css          # Toasts, instant label animation (overlay)
│       │   ├── inline-suggestion.css  # Inline suggestion (overlay)
│       │   ├── selection.css        # Select-to-Translate icon and popup (overlay)
│       │   └── hover-translate.css  # Hover translations injected into pages (global)
│       └── icons/
├── landing/                         # Static website, deployed to GitHub Pages
├── tests/e2e/                       # Playwright end-to-end tests
├── eslint.config.mjs
├── .prettierrc
├── playwright.config.mjs
└── package.json                     # Lint and test tooling only
```

## Development Setup

1.  Install the lint tooling: `npm install`.
2.  Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked** and select the **`extension/`** directory.
3.  After a change, click the reload icon on the extension card and refresh the test page (content scripts only reload with the page).
4.  Debug the service worker from the "service worker" link on the extension card, content scripts from the page's DevTools, and the popup with right-click → Inspect. The overlay's shadow root is closed, but DevTools can still inspect it.

For the **Chrome Built-in AI** provider, use a Chrome version that supports the `Translator` and `LanguageDetector` APIs. On older or development builds you may need these flags:

-   `chrome://flags/#prompt-api-for-gemini-nano`
-   `chrome://flags/#writer-api-for-gemini-nano`
-   `chrome://flags/#language-detection-api`

Other providers only need their API key or endpoint in the settings.

### Linting

`npm run lint` runs ESLint and Prettier with `--fix` / `--write` on `extension/` and `landing/`. Parts of the codebase predate the Prettier config, so the command can reformat lines you did not touch. Review the diff before committing.

### Testing

#### Automated end-to-end tests

`tests/e2e/` holds a [Playwright](https://playwright.dev) suite that loads the unpacked extension into headless Chromium:

```bash
npm install
npx playwright install chromium   # once
npm run test:e2e
```

-   `tests/e2e/server.mjs` serves `pages/hostile.html` (a page with CSS that used to break TransKit's UI) and a **mock OpenAI-compatible endpoint**. The suite seeds two `custom` providers ("Mock A" / "Mock B") pointing at it, so tests run offline. The mock replies `<model>:<target language>:<text>`. Text containing `[slow]` is answered after 1.5 s.
-   TransKit's UI lives in a closed shadow root that Playwright locators cannot reach. The `Overlay` helper in `fixtures.mjs` reads it through CDP (`DOM.getDocument` with `pierce: true`): `find`, `box`, `computed`, `eval`, `click`.
-   Pass settings overrides per test with `test.use({ settings: { ... } })`.
-   The suite runs in GitHub Actions on pull requests that touch the extension (`.github/workflows/e2e.yml`).

#### Manual checks

The suite does not cover everything. After a change, also check the affected flows on a few real sites:

-   Real translation providers, including Chrome Built-in AI
-   Hover translate (inject and replace modes) and TTS
-   Sites such as YouTube, Gmail and pages with `<dialog>` modals
-   Reloading the extension while a page is open: content scripts must not throw "Extension context invalidated" (see `EXTENSION_CONTEXT_FIX.md`)

## Key APIs Used

-   `chrome.runtime`: messaging and lifecycle.
-   `chrome.storage`: settings.
-   `chrome.offscreen`: the hidden document for built-in AI and audio.
-   `Translator`, `LanguageDetector`: Chrome's on-device AI APIs.
-   Shadow DOM and the Popover API: the isolated UI overlay.
