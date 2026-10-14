import { AIProviderService } from "./services/ai-providers.js";
import { htmlToMarkdown, markdownToHtml, shouldConvertFormat } from "./services/format-utils.js";

const OFFSCREEN_URL = chrome.runtime.getURL("../pages/offscreen.html");
const SETTINGS_KEY = "translatorSettings";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const hasOffscreen = contexts.some(
    (c) =>
      c.contextType === "OFFSCREEN_DOCUMENT" && c.documentUrl === OFFSCREEN_URL
  );

  if (!hasOffscreen) {
    await chrome.offscreen.createDocument({
      url: "../pages/offscreen.html",
      reasons: ["IFRAME_SCRIPTING"],
      justification:
        "Use built-in Translator and LanguageDetector APIs in a windowed context."
    });
  }
}

async function readSettings() {
  const { translatorSettings } = await chrome.storage.local.get(SETTINGS_KEY);
  return (
    translatorSettings || {
      enabled: true,
      nativeLanguageCode: "vi",
      targetLanguageCode: "en",
      useAutoDetect: false, // Default to fixed direction (Target→Native)
      showConfirmModal: true,
      dialogTimeout: 10,
      aliases: {
        e: "en",
        v: "vi",
        ch: "zh",
        j: "ja"
      },
      interfaceLanguage: "en",
      // Instant translate settings
      instantTranslateEnabled: false,
      instantDelay: 3000,
      instantDomains: [
        { domain: "telegram.org", enabled: true, position: "top" },
        { domain: "discord.com", enabled: true, position: "top" },
        { domain: "zalo.me", enabled: true, position: "top" },
        { domain: "openai.com", enabled: true, position: "top" },
        { domain: "claude.ai", enabled: true, position: "top" },
        { domain: "gemini.google.com", enabled: true, position: "top" }
      ],
      // AI Provider settings
      activeProviderId: "google-translate",
      providers: [
        {
          id: "google-translate",
          type: "google-translate",
          name: "Google Translate",
          config: {}
        },
        // Microsoft Translate removed - requires Authorization
        // {
        //   id: "microsoft-translate",
        //   type: "microsoft-translate",
        //   name: "Microsoft Translate (Bing)",
        //   config: {}
        // },
        {
          id: "builtin",
          type: "gemini-nano",
          name: "Chrome Built-in AI",
          config: {}
        }
      ],
      // Keyboard shortcut for toggle instant domain
      instantToggleShortcut: {
        key: "I",
        ctrl: true,
        shift: true,
        alt: false
      },
      // Hover to Translate settings
      hoverTranslateEnabled: false,
      hoverTranslateMode: "inject", // "inject" or "replace"
      hoverTranslateDomains: [],
      hoverModifierKey: "ctrl", // "ctrl", "shift", "alt"
      hoverToggleShortcut: {
        key: "O",
        ctrl: true,
        shift: true,
        alt: false
      },
      // Style customization for hover inject mode
      hoverInjectStyle: {
        backgroundColor: "#667eea",
        textColor: "#0c69e4",
        fontSize: "0.95em",
        showIcon: true,
        underline: false
      },
      // Last used languages in Selection Popup
      selectionLastSource: null,
      selectionLastTarget: null
    }
  );
}

async function writeSettings(next) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// Merge a partial update into the latest stored settings. Updates are chained
// so two quick changes can't both read the old value and overwrite each other.
let settingsUpdateQueue = Promise.resolve();
function updateSettings(patch) {
  const run = settingsUpdateQueue.then(async () => {
    const current = await readSettings();
    return writeSettings({ ...current, ...patch });
  });
  settingsUpdateQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "get-settings") {
    readSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }

  if (message?.type === "set-settings") {
    writeSettings(message.settings).then((s) =>
      sendResponse({ ok: true, settings: s })
    );
    return true;
  }

  if (message?.type === "update-settings") {
    updateSettings(message.patch)
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "translate") {
    readSettings().then(async (settings) => {
      // Extract payload using keys sent by content-script.js
      const { text, nativeLanguageCode, targetLanguage, sourceLanguage, providerId } = message.payload;
      
      // Map to standardized keys for AIProviderService
      // Use 'auto' if sourceLanguage is not explicitly provided
      const sourceLang = sourceLanguage || "auto"; 
      const targetLang = targetLanguage;

      const aiService = new AIProviderService(settings);
      
      // Determine the provider type to use
      const activeProvider = providerId 
        ? settings.providers.find(p => p.id === providerId)
        : settings.providers.find(p => p.id === settings.activeProviderId);
      
      const providerType = activeProvider?.type || "gemini-nano";

      try {
        // --- Format Conversion Logic ---
        let textToTranslate = text;
        let hasFormatting = false;
        
        // Apply format conversion for all providers
        if (shouldConvertFormat(text)) {
          textToTranslate = htmlToMarkdown(text);
          hasFormatting = true;
        }
        
        const result = await aiService.translate(textToTranslate, sourceLang, targetLang, providerId);
        
        // If result is the special signal for Window AI, use offscreen
        if (result?.useOffscreen) {
          await ensureOffscreen();
          const offscreenResult = await chrome.runtime.sendMessage({ 
            type: "offscreen-translate", 
            payload: { ...message.payload, text: textToTranslate }
          });
          
          if (offscreenResult?.ok) {
            let translation = offscreenResult.translation;
            
            // Convert back to HTML if formatting was converted
            if (hasFormatting && translation) {
              translation = markdownToHtml(translation);
            }
            
            // offscreenResult is { ok: true, translation: "...", ... }
            // We need to construct the result object expected by content-script
            const resultObj = {
              translation: translation,
              sourceLanguage: offscreenResult.sourceLanguage,
              targetLanguage: offscreenResult.targetLanguage,
              providerName: offscreenResult.providerName || "Chrome Built-in AI",
              providerType: offscreenResult.providerType || "Built-in"
            };
            
            sendResponse({ ok: true, result: resultObj });
          } else {
            sendResponse({ ok: false, error: offscreenResult?.error || "Unknown error" });
          }
        } else {
          // Convert back to HTML if formatting was converted
          let translation = result.translation;
          if (hasFormatting && translation) {
            translation = markdownToHtml(translation);
          }
          
          // Result is the object { translation, providerName, providerType }
          sendResponse({ 
            ok: true, 
            result: {
              translation: translation,
              providerName: result.providerName,
              providerType: result.providerType,
              sourceLanguage: sourceLang,
              targetLanguage: targetLang
            }
          });
        }
      } catch (err) {
        console.error("Translation Error:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    });

    return true;
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
    return true;
  }
  if (message?.type === "tts-play") {
    ensureOffscreen().then(async () => {
      try {
        await chrome.runtime.sendMessage({
          type: "play-tts",
          payload: message.payload
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    });
    return true;
  }
});
