let normalizeLanguageToCode;
let i18n;
let tts;

const TRANSLATION_COMMAND_PATTERN = /!!([a-zA-ZÀ-ÿ\-]+)$/i;

let isTranslating = false;
let debounceTimer = null;

// Instant translate state
let instantTimer = null;
let currentSuggestion = null;
let justAppliedTranslation = false;
let currentKeyHandler = null; // Track active keyboard handler
let isIMEComposing = false; // Track if IME composition is active

// Select-to-translate state
let selectionIcon = null;
let selectionPopup = null;
let selectedText = "";

const commonStyles = {
  fontFamily: "system-ui, sans-serif",
  background: "#FFFF",
  color: "#1C2024",
  borderRadius: "0.375rem",
  boxShadow: "0 .375rem 1.5rem #0000000f",
  zIndex: "9999999999"
};

// Global error handler for extension context invalidation
window.addEventListener('error', (event) => {
  if (event.error && event.error.message && 
      (event.error.message.includes('Extension context invalidated') ||
       event.error.message.includes('Could not establish connection') ||
       event.error.message.includes('receiving end does not exist'))) {
    console.log('TransKit: Caught global extension context invalidation error');
    cleanupExtensionElements();
    event.preventDefault(); // Prevent the error from being logged to console
  }
});

// Global unhandled promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && event.reason.message && 
      (event.reason.message.includes('Extension context invalidated') ||
       event.reason.message.includes('Could not establish connection') ||
       event.reason.message.includes('receiving end does not exist'))) {
    console.log('TransKit: Caught unhandled promise rejection for extension context invalidation');
    cleanupExtensionElements();
    event.preventDefault(); // Prevent the error from being logged to console
  }
});

(async function bootstrap() {
  try {
    if (!isExtensionContextValid()) {
      console.log('TransKit: Extension context not available during bootstrap');
      return;
    }

    // Wrap all chrome.runtime calls in try-catch
    let mod, i18nMod, ttsMod;
    try {
      mod = await import(chrome.runtime.getURL("src/common/language-map.js"));
      normalizeLanguageToCode = mod.normalizeLanguageToCode;
      
      i18nMod = await import(chrome.runtime.getURL("src/common/i18n.js"));
      i18n = i18nMod.i18n;

      ttsMod = await import(chrome.runtime.getURL("src/services/tts.js"));
      tts = ttsMod.tts;
    } catch (importError) {
      if (importError.message.includes('Extension context invalidated') || 
          importError.message.includes('Could not establish connection')) {
        console.log('TransKit: Extension context invalidated during import');
        cleanupExtensionElements();
        return;
      }
      throw importError;
    }
    
    // Initialize i18n with current settings
    getSettings().then(settings => {
      if (settings.interfaceLanguage) {
        i18n.setLanguage(settings.interfaceLanguage);
      }
    }).catch(err => {
      console.log('TransKit: Error initializing i18n:', err.message);
    });

    // Listen for setting changes
    try {
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.translatorSettings) {
          const newSettings = changes.translatorSettings.newValue;
          if (newSettings && newSettings.interfaceLanguage) {
            i18n.setLanguage(newSettings.interfaceLanguage);
          }
        }
      });
    } catch (storageError) {
      console.log('TransKit: Error setting up storage listener:', storageError.message);
    }
    
    injectGlobalStylesheet();
    registerAutoDetection();
    registerInstantMode();
    registerSelectionMode();
    registerInstantToggleShortcut();
    registerInstantLabelIndicator();
    registerHoverTranslate();
    registerHoverToggleShortcut();
  } catch (error) {
    console.log('TransKit: Bootstrap failed:', error.message);
    if (error.message.includes('Extension context invalidated') || 
        error.message.includes('Could not establish connection')) {
      // Extension was reloaded, clean up and exit gracefully
      cleanupExtensionElements();
    }
  }
})();

function injectGlobalStylesheet() {
  try {
    if (!isExtensionContextValid()) {
      return;
    }
    
    const href = chrome.runtime.getURL("assets/styles/dialogs.css");
    if (![...document.styleSheets].some((s) => s.href === href)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
  } catch (error) {
    console.log('TransKit: Error injecting stylesheet:', error.message);
    if (error.message.includes('Extension context invalidated') || 
        error.message.includes('Could not establish connection')) {
      cleanupExtensionElements();
    }
  }
}

function isEditableElement(element) {
  if (!element) return false;

  const tag = element.tagName?.toLowerCase();

  if (tag === "input") {
    const type = element.getAttribute("type") || "text";
    return (
      ["text", "search", "email", "url", "tel", "password"].includes(type) ||
      !type
    );
  }

  if (tag === "textarea") return true;
  if (element.isContentEditable) return true;

  return false;
}

function getDeepActiveElement(root = document) {
  let element = root.activeElement || null;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element;
}

function getActiveEditableElement() {
  const element = getDeepActiveElement();
  return isEditableElement(element) ? element : null;
}

function parseFieldTextAndCommand(element) {
  if (!element) return null;

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
  } else if (element.isContentEditable) {
    value = element.innerText;
  }

  const match = value.match(TRANSLATION_COMMAND_PATTERN);
  if (!match) return null;

  const languageRaw = match[1];
  const precedingText = value.slice(0, match.index).trimEnd();
  return { text: precedingText, languageRaw };
}

function createOverlayShadowHost() {
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = commonStyles.zIndex;
  host.style.inset = "0";
  host.style.pointerEvents = "none"; // Ensure clicks pass through the host
  document.documentElement.appendChild(host);
  return host.attachShadow({ mode: "closed" });
}

function attachStylesheetToShadowRoot(shadowRoot) {
  const href = chrome.runtime.getURL("assets/styles/dialogs.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  shadowRoot.appendChild(link);
}



async function getSettings() {
  if (!isExtensionContextValid()) {
    // Don't show toast, just return default settings
    return {
      enabled: false,
      nativeLanguageCode: "vi",
      targetLanguageCode: "en",
      useAutoDetect: false,
      showConfirmModal: true,
      dialogTimeout: 10,
      aliases: {},
      interfaceLanguage: "en"
    };
  }
  
  try {
    // Double-check context validity before making the call
    if (!isExtensionContextValid()) {
      throw new Error('Extension context invalidated');
    }
    
    const res = await chrome.runtime.sendMessage({ type: "get-settings" });
    if (res?.ok) {
      // Initialize i18n with the fetched language setting
      if (i18n) {
        i18n.setLanguage(res.settings.interfaceLanguage || "en");
      }
      return res.settings;
    }
  } catch (error) {
    console.log('TransKit: Error getting settings:', error.message);
    if (error.message.includes('Extension context invalidated') || error.message.includes('Could not establish connection')) {
      cleanupExtensionElements();
    }
  }
  
  return {
    enabled: true,
    nativeLanguageCode: "vi",
    targetLanguageCode: "en",
    useAutoDetect: false,
    showConfirmModal: true,
    dialogTimeout: 10,
    aliases: {},
    interfaceLanguage: "en"
  };
}

async function requestTranslation(payload) {
  if (!isExtensionContextValid()) {
    throw new Error(i18n.t("toast.extensionUpdated"));
  }
  
  try {
    // Double-check context validity before making the call
    if (!isExtensionContextValid()) {
      throw new Error('Extension context invalidated');
    }
    
    return chrome.runtime.sendMessage({ type: "translate", payload });
  } catch (error) {
    if (error.message.includes('Extension context invalidated') || error.message.includes('Could not establish connection')) {
      cleanupExtensionElements();
      throw new Error(i18n.t("toast.extensionUpdated"));
    }
    throw error;
  }
}

function removeTranslationCommandSuffix(element) {
  if (!element) return "";

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return value;
  }

  if (element.isContentEditable) {
    value = element.innerText;
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    element.textContent = value;
    return value;
  }

  return "";
}

function showToast(message) {
  const host = document.createElement("div");
  const lowerMsg = message.toLowerCase();

  // Determine toast type and icon
  let icon = '•';
  let toastType = 'default'; // default, warning, success

  if (lowerMsg.includes('translating') || lowerMsg.includes('đang dịch')) {
    icon = '⏳';
    toastType = 'default';
  } else if (lowerMsg.includes('enabled') || lowerMsg.includes('đã bật')) {
    icon = '✓';
    toastType = 'success';
  } else if (lowerMsg.includes('disabled') || lowerMsg.includes('đã tắt')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('failed') || lowerMsg.includes('thất bại')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('updated') || lowerMsg.includes('cập nhật')) {
    icon = 'ℹ️';
    toastType = 'default';
  } else if (lowerMsg.includes('error') || lowerMsg.includes('lỗi')) {
    icon = '❌';
    toastType = 'warning';
  } else if (lowerMsg.includes('invalid') || lowerMsg.includes('không hợp lệ')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('instant')) {
    icon = '⚡';
    toastType = 'default';
  }

  // Set class based on type
  host.className = `bt-toast-notify bt-toast-notify-${toastType} bt-vars-container`;

  host.innerHTML = `
    <div class="bt-toast-notify-content">
      <span class="bt-toast-notify-icon">${icon}</span>
      <span class="bt-toast-notify-text">${message}</span>
    </div>
  `;
  document.documentElement.appendChild(host);

  // Fade out animation - close faster
  setTimeout(() => {
    host.classList.add('bt-toast-notify-exit');
    setTimeout(() => host.remove(), 300);
  }, 1500);
}

function registerAutoDetection() {
  document.addEventListener("input", handleUserInputEvent, true);
  document.addEventListener("blur", handleUserInputEvent, true);
}

function handleUserInputEvent() {
  const element = getActiveEditableElement();
  if (!element) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => attemptTranslationTrigger(element), 600);
}

function attemptTranslationTrigger(element) {
  if (isTranslating) return;
  const parsed = parseFieldTextAndCommand(element);
  if (!parsed) return;
  handleAutoTranslation(element, parsed);
}

function resolveTargetLanguage(raw, settings) {
  if (raw === "t") return settings.targetLanguageCode || "en";
  
  // Check aliases
  if (settings.aliases && settings.aliases[raw]) {
    return settings.aliases[raw];
  }

  // Fallback to normalization (e.g. "english" -> "en")
  return normalizeLanguageToCode(raw);
}

async function handleAutoTranslation(element, parsed) {
  isTranslating = true;
  let suggestion = null;

  try {
    const baseText = parsed.text;
    
    // Wrap getSettings to catch invalidation early
    let settings;
    try {
      settings = await getSettings();
    } catch (e) {
      if (e.message.includes("Extension context invalidated")) {
        showToast(i18n.t("toast.extensionUpdated"));
        return;
      }
      throw e;
    }

    if (settings.enabled === false) return;

    // Skip if this domain is already handled by instant translation
    if (isInstantDomain(settings)) return;

    const targetCode = resolveTargetLanguage(parsed.languageRaw, settings);

    if (!baseText || !baseText.trim()) return;
    if (!targetCode) {
      showToast(i18n.t("toast.invalidLanguage"));
      return;
    }

    const cleanSourceValue = removeTranslationCommandSuffix(element);
    
    // If confirm is OFF, just translate and replace immediately
    if (!settings.showConfirmModal) {
      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }
      let res;
      try {
        res = await requestTranslation({
          text: cleanSourceValue,
          nativeLanguageCode: settings.nativeLanguageCode || "en",
          targetLanguage: targetCode,
          useAutoDetect: settings.useAutoDetect === true
        });
      } catch (e) {
        showToast(e.message || i18n.t("toast.translationFailed"));
        return;
      }

      if (res?.ok && res.result?.translation) {
        setFieldText(element, res.result.translation);
      } else {
        showToast(res?.error ? String(res.error) : i18n.t("toast.translationFailed"));
      }
      return;
    }

    // If confirm is ON, show inline suggestion
    // Only show loading for non-builtin models
    if (settings.activeProviderId !== "builtin") {
      showToast(i18n.t("toast.translating"));
    }

    let res;
    try {
      res = await requestTranslation({
        text: cleanSourceValue,
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: targetCode,
        useAutoDetect: settings.useAutoDetect === true
      });
    } catch (e) {
      showToast(e.message || i18n.t("toast.translationFailed"));
      return;
    }

    if (!res || !res.ok || !res.result?.translation) {
      showToast(res?.error ? String(res.error) : i18n.t("toast.translationFailed"));
      return;
    }

    const translation = res.result.translation;
    const providerInfo = `${res.result.providerName || 'AI'} (${res.result.providerType || 'Bot'})`;

    // Use buildInlineSuggestion with auto positioning
    suggestion = buildInlineSuggestion(element, translation, providerInfo, 'auto');
    
    // Setup Tab/Esc handlers
    const handleKeydown = (ev) => {
      if (ev.key === "Tab") {
        ev.preventDefault();
        setFieldText(element, translation);
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      }
    };

    document.addEventListener("keydown", handleKeydown, true);

    // Cleanup if element loses focus or is removed
    const onBlur = () => {
      suggestion.destroy();
      document.removeEventListener("keydown", handleKeydown, true);
      element.removeEventListener("blur", onBlur);
    };
    element.addEventListener("blur", onBlur);

  } catch (err) {
    if (suggestion) suggestion.destroy();
    showToast(err.message || "An error occurred");
    console.error(err);
  } finally {
    isTranslating = false;
  }
}

// ============================================
// INSTANT TRANSLATE MODE
// ============================================

function isInstantDomain(settings) {
  if (!settings.instantTranslateEnabled) return null;
  
  const currentUrl = window.location.href;
  return settings.instantDomains.find(
    d => d.enabled && currentUrl.includes(d.domain)
  ) || null;
}

function shouldTriggerInstant(text) {
  // Don't trigger if:
  if (!text || text.trim().length < 5) return false; // Too short
  if (/^https?:\/\//.test(text)) return false; // URL
  if (/^[!@#$%^&*()_+=\[\]{};':"\\|,.<>/?`~-]+$/.test(text)) return false; // Only special chars
  return true;
}

function setFieldText(element, text, options = {}) {
  const { immediate = false } = options;
  const tag = element.tagName?.toLowerCase();

  // Ensure element has focus first
  if (document.activeElement !== element) {
    element.focus();
  }

  if (tag === "input" || tag === "textarea") {
    // Use native setter to bypass React's value tracking
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, text);
    } else {
      element.value = text;
    }

    // Trigger React's onChange by dispatching input event
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (element.isContentEditable) {
    const performInsertion = () => {
      // Ensure focus again
      if (document.activeElement !== element) {
        element.focus();
      }

      try {
        // SOLUTION: Works with Lexical Editor (Facebook's editor framework)
        // Key: Need 50ms delay after selectAll for Lexical to process selection

        // Step 1: Focus element
        element.focus();

        // Step 2: Select all content
        document.execCommand('selectAll', false, null);

        // Step 3: CRITICAL DELAY - Wait for Lexical to process selection
        setTimeout(() => {
          // Step 4: Insert text (replaces selection)
          document.execCommand('insertText', false, text);

          // Step 5: Dispatch input event for React/Lexical
          element.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }, 50);

      } catch (e) {
        console.error("[TransKit] Insertion failed", e);
      }
    };

    // For instant translate with Tab, execute IMMEDIATELY and SYNCHRONOUSLY
    // Based on tests: execCommand works but async delays cause Facebook to revert
    if (immediate) {
      performInsertion();
    } else {
      setTimeout(performInsertion, 0);
    }
  }
}

function buildInlineSuggestion(element, translatedText, providerInfo, position = 'auto', settings = {}) {
  const container = document.createElement('div');
  container.className = 'bt-inline-suggestion bt-vars-container';

  // Position relative to input
  const rect = element.getBoundingClientRect();
  container.style.position = 'fixed';
  container.style.zIndex = '9999999999';

  // Smart width calculation to prevent UI breaking on small inputs
  const minPopupWidth = 320;
  const maxPopupWidth = 600;
  const inputWidth = rect.width;

  // Calculate popup width with constraints
  let popupWidth = Math.max(inputWidth - 80, minPopupWidth);
  popupWidth = Math.min(popupWidth, maxPopupWidth);

  container.style.width = `${popupWidth}px`;
  container.style.minWidth = `${minPopupWidth}px`;
  container.style.maxWidth = `${maxPopupWidth}px`;

  // Smart horizontal positioning
  let leftPos = rect.left;

  // Get available viewport considering panels
  const viewport = getAvailableViewport();

  // If popup is wider than input, center it relative to input
  if (popupWidth > inputWidth) {
    leftPos = rect.left - (popupWidth - inputWidth) / 2;

    // Keep popup within viewport considering panel offsets
    const maxLeft = viewport.width + viewport.leftOffset - popupWidth - 10;
    const minLeft = viewport.leftOffset + 10;
    leftPos = Math.max(minLeft, Math.min(leftPos, maxLeft));
  }

  container.style.left = `${leftPos}px`;

  // AUTO-DETECT optimal vertical position
  let finalPosition = position;

  if (position === 'auto') {
    // Calculate available space above and below
    const spaceAbove = rect.top;
    const spaceBelow = viewport.height - rect.bottom;

    // Estimate popup height (will be more accurate after render)
    const estimatedPopupHeight = 100;
    const minSpaceNeeded = 120;

    // Prefer bottom if enough space, otherwise use position with more space
    if (spaceBelow >= minSpaceNeeded) {
      finalPosition = 'bottom';
    } else if (spaceAbove >= minSpaceNeeded) {
      finalPosition = 'top';
    } else {
      // Choose side with more space
      finalPosition = spaceAbove > spaceBelow ? 'top' : 'bottom';
    }
  }

  // Set vertical position based on final decision
  if (finalPosition === 'top') {
    container.style.bottom = `${viewport.height - rect.top + 8}px`;
    container.classList.add('bt-popup-top');
  } else {
    container.style.top = `${rect.bottom + 8}px`;
    container.classList.add('bt-popup-bottom');
  }
  
  // Add to DOM first to get dimensions
  document.body.appendChild(container);
  
  // Get container dimensions and adjust position if needed
  const containerRect = container.getBoundingClientRect();
  
  // Ensure container stays within viewport bounds
  if (finalPosition === 'bottom' && containerRect.bottom > viewport.height - 10) {
    // If bottom position causes overflow, try top position
    if (rect.top - containerRect.height - 8 >= 10) {
      container.style.top = '';
      container.style.bottom = `${viewport.height - rect.top + 8}px`;
      container.classList.remove('bt-popup-bottom');
      container.classList.add('bt-popup-top');
    } else {
      // Adjust to fit within viewport
      container.style.top = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  } else if (finalPosition === 'top' && containerRect.top < 10) {
    // If top position causes overflow, try bottom position
    if (rect.bottom + containerRect.height + 8 <= viewport.height - 10) {
      container.style.bottom = '';
      container.style.top = `${rect.bottom + 8}px`;
      container.classList.remove('bt-popup-top');
      container.classList.add('bt-popup-bottom');
    } else {
      // Adjust to fit within viewport
      container.style.bottom = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  }
  
  // Remove from DOM temporarily to continue setup
  container.remove();
  
  let iconUrl;
  try {
    iconUrl = isExtensionContextValid() ? chrome.runtime.getURL('assets/icons/icon-19.png') : '';
  } catch (error) {
    console.log('TransKit: Error getting icon URL:', error.message);
    iconUrl = '';
  }
  
  container.innerHTML = `
    <div class="bt-suggestion-content">
      ${iconUrl ? `<img src="${iconUrl}" class="bt-suggestion-icon" alt="TransKit" />` : '<span class="bt-suggestion-icon">🔄</span>'}
      <span class="bt-suggestion-text">${translatedText}</span>
      <kbd class="bt-suggestion-tab-hint">Tab</kbd>
    </div>
    <div class="bt-suggestion-footer">
      <div class="bt-suggestion-provider-container"></div>
    </div>
  `;
  
  // Prevent clicking on the suggestion from blurring the input
  // EXCEPT for select elements (allow clicking model selector)
  const preventBlur = (e) => {
    // Allow clicks on select elements
    if (e.target.tagName === 'SELECT' || e.target.closest('select')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener('mousedown', preventBlur);
  container.addEventListener('pointerdown', preventBlur);
  
  const providerContainer = container.querySelector('.bt-suggestion-provider-container');
  const providerSelect = populateProviderSelectorForSuggestion(providerContainer, settings);

  document.body.appendChild(container);

  return {
    element: container,
    translatedText,
    providerSelect,
    destroy: () => {
      container.remove();
    }
  };
}

function populateProviderSelectorForSuggestion(container, settings) {
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || 'builtin';

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: 'Chrome Built-in AI' };
    const tag = document.createElement('span');
    tag.className = 'bt-model-tag';
    tag.textContent = provider.name;
    container.appendChild(tag);
    return null;
  } else {
    // Show as a select dropdown
    const label = document.createElement('span');
    label.className = 'bt-suggestion-provider-label';
    label.textContent = 'Model: ';
    
    const select = document.createElement('select');
    select.className = 'bt-suggestion-provider-select';
    select.tabIndex = -1; // CRITICAL: Prevent Tab key from focusing this element
    
    providers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });
    
    container.appendChild(label);
    container.appendChild(select);
    
    return select;
  }
}


function setupSuggestionKeyHandlers(element, suggestion) {
  // CRITICAL: Remove any existing handler first
  if (currentKeyHandler) {
    window.removeEventListener("keydown", currentKeyHandler, true);
    window.removeEventListener("keyup", currentKeyHandler, true);
    document.removeEventListener("keydown", currentKeyHandler, true);
    document.removeEventListener("keyup", currentKeyHandler, true);
    currentKeyHandler = null;
  }

  let isApplying = false; // Prevent multiple calls

  const handleKey = (ev) => {
    // Only handle specific keys, let everything else pass through
    if (ev.key === "Tab") {
      // CRITICAL: Block ALL propagation immediately and synchronously
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      // Legacy support
      if (ev.returnValue !== undefined) {
        ev.returnValue = false;
      }

      // Only process on keydown, just block keyup
      if (ev.type === "keyup") return false;

      // Prevent multiple calls
      if (isApplying) return false;

      // Apply translation (async, but we don't await in event handler)
      applyTranslation();
      return false;
    }

    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      if (ev.type === "keyup") return false;
      dismiss();
      return false;
    }

    if (ev.key === "Backspace" || ev.key === "Delete") {
      if (ev.type === "keyup") return;
      dismiss();
      return;
    }
  };

  const applyTranslation = async () => {
    // Prevent re-entry
    if (isApplying) return;
    isApplying = true;

    // Commit IME composition before applying translation and wait for completion
    await commitIMEComposition(element);

    // Cleanup FIRST to prevent any interference
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;

    // Set flag to prevent instant translate from re-triggering
    justAppliedTranslation = true;

    // Apply translation IMMEDIATELY with Lexical-compatible method
    setFieldText(element, suggestion.translatedText, { immediate: true });

    // Destroy popup after a tiny delay to ensure insertion completes
    setTimeout(() => {
      if (suggestion) {
        suggestion.destroy();
      }
      currentSuggestion = null;
    }, 50);

    // Clear flag after a short delay
    setTimeout(() => {
      justAppliedTranslation = false;
    }, 500);
  };

  const dismiss = () => {
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;
    suggestion.destroy();
    currentSuggestion = null;
  };

  // Store reference and add listeners at MULTIPLE levels with CAPTURE
  // This ensures we catch the event before Facebook's handlers
  currentKeyHandler = handleKey;

  // Add at both window and document level for maximum coverage
  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("keyup", handleKey, true);
  document.addEventListener("keydown", handleKey, true);
  document.addEventListener("keyup", handleKey, true);
}

// Commit IME composition by blur/focus
// This is needed for macOS IME (Vietnamese, Chinese, Japanese, etc.)
// to ensure the underline is removed before showing the translation popup
async function commitIMEComposition(element) {
  if (!isIMEComposing) return;

  try {
    // Blur triggers browser to fire compositionend event and commit IME
    element.blur();
    await new Promise(resolve => setTimeout(resolve, 10));

    // Re-focus to keep input active
    element.focus();
    await new Promise(resolve => setTimeout(resolve, 50));
  } catch (err) {
    console.error("Error committing IME composition:", err);
  }
}

async function handleInstantTranslate(element) {
  // Skip if we just applied a translation
  if (justAppliedTranslation) return;
  
  const text = element.value?.trim() || element.innerText?.trim();
  if (!shouldTriggerInstant(text)) return;
  
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    return; // Silently fail if settings unavailable
  }
  
  const domainConfig = isInstantDomain(settings);
  if (!domainConfig) return;
  
  // Clear existing timer
  if (instantTimer) {
    clearTimeout(instantTimer);
    instantTimer = null;
  }
  
  // Dismiss existing suggestion
  if (currentSuggestion) {
    currentSuggestion.destroy();
    currentSuggestion = null;
  }
  
  // Start new timer
  instantTimer = setTimeout(async () => {
    try {
      // Commit IME composition before translation
      await commitIMEComposition(element);

      // Get fresh text after IME composition is committed
      const freshText = element.value?.trim() || element.innerText?.trim();

      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }

      const res = await requestTranslation({
        text: freshText,
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: settings.targetLanguageCode || "en",
        sourceLanguage: settings.nativeLanguageCode || "en", // Always translate from native language
        useAutoDetect: false // Never auto-detect for instant (always Native→Target)
      });
      
      if (res?.ok && res.result?.translation) {
        // Use 'auto' by default for smart positioning
        const position = domainConfig.position || 'auto';
        const providerInfo = `${res.result.providerName || 'AI'} (${res.result.providerType || 'Bot'})`;
        currentSuggestion = buildInlineSuggestion(element, res.result.translation, providerInfo, position, settings);
        setupSuggestionKeyHandlers(element, currentSuggestion);

        // Handle provider change
        if (currentSuggestion.providerSelect) {
          currentSuggestion.providerSelect.addEventListener('change', (e) => {
            reTranslateSuggestion(element, text, e.target.value, settings);
          });
        }
      } else {
        // Show error toast when translation fails
        showToast(res?.error || i18n.t("toast.translationFailed"));
      }
    } catch (err) {
      console.error("Instant translate error:", err);
      showToast(i18n.t("toast.translationFailed"));
    }
  }, settings.instantDelay || 3000);
}

async function reTranslateSuggestion(element, text, providerId, settings) {
  if (!currentSuggestion) return;
  
  const textEl = currentSuggestion.element.querySelector('.bt-suggestion-text');
  if (textEl) {
    textEl.textContent = i18n.t("dialog.translating");
    textEl.classList.add('bt-loading-text');
  }
  
  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.targetLanguageCode || "es",
      useAutoDetect: settings.useAutoDetect === true,
      providerId: providerId
    });
    
    if (res?.ok && res.result?.translation) {
      if (textEl) {
        textEl.textContent = res.result.translation;
        textEl.classList.remove('bt-loading-text');
      }
      currentSuggestion.translatedText = res.result.translation;
    }
  } catch (err) {
    console.error("Re-translation error:", err);
    if (textEl) {
      textEl.textContent = "Error: " + err.message;
      textEl.classList.remove('bt-loading-text');
    }
  }
}


function registerInstantMode() {
  // Listen for input changes
  document.addEventListener('input', async (e) => {
    const element = getActiveEditableElement();
    if (!element) return;

    // Don't interfere with manual mode
    if (isTranslating) return;

    // Check if manual command is being typed
    const text = element.value?.trim() || element.innerText?.trim();
    if (TRANSLATION_COMMAND_PATTERN.test(text)) return;

    handleInstantTranslate(element);
  }, true);

  // Track IME composition state for proper handling
  document.addEventListener('compositionstart', () => {
    isIMEComposing = true;
  }, true);

  document.addEventListener('compositionend', () => {
    isIMEComposing = false;
  }, true);

  // Handle click outside to close suggestion
  document.addEventListener('mousedown', (e) => {
    if (currentSuggestion) {
      const isInsideInput = e.target === getActiveEditableElement();
      const isInsideSuggestion = currentSuggestion.element.contains(e.target);
      
      if (!isInsideInput && !isInsideSuggestion) {
        // Cleanup key handler if it exists
        if (currentKeyHandler) {
          document.removeEventListener("keydown", currentKeyHandler, true);
          currentKeyHandler = null;
        }
        
        currentSuggestion.destroy();
        currentSuggestion = null;
      }
    }
  });
  
  // Listen for Enter key to cancel instant translate
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // User wants to send message immediately, cancel any pending translation
      if (instantTimer) {
        clearTimeout(instantTimer);
        instantTimer = null;
      }
      
      // Dismiss any visible suggestion
      if (currentSuggestion) {
        currentSuggestion.destroy();
        currentSuggestion = null;
      }
      
      // Remove keyboard handler if active
      if (currentKeyHandler) {
        document.removeEventListener("keydown", currentKeyHandler, true);
        currentKeyHandler = null;
      }
    }
  }, true);
}

// ============================================
// INSTANT TOGGLE SHORTCUT
// ============================================

async function toggleInstantDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const currentUrl = window.location.href;

    // If global setting is disabled, enable it and FORCE enable the domain
    if (!settings.instantDomains) {
      settings.instantDomains = [];
    }

    // Find matching domain
    const matchingDomainIndex = settings.instantDomains.findIndex(
      d => currentUrl.includes(d.domain)
    );

    if (!settings.instantTranslateEnabled) {
      settings.instantTranslateEnabled = true;
      
      if (matchingDomainIndex !== -1) {
        // Force enable if it exists
        settings.instantDomains[matchingDomainIndex].enabled = true;
      }
      // If it doesn't exist, it will be added below
    } else if (matchingDomainIndex !== -1) {
      // Global is already on, so we just toggle the domain
      settings.instantDomains[matchingDomainIndex].enabled = !settings.instantDomains[matchingDomainIndex].enabled;
    }

    if (matchingDomainIndex === -1) {
      // Current domain not in list - AUTO-ADD IT!
      const domain = extractDomainFromUrl(currentUrl);
      
      // Add to list with enabled: true, position: 'auto'
      settings.instantDomains.push({
        domain: domain,
        enabled: true,
        position: 'auto'
      });
      
      // Save settings
      try {
        await safeRuntimeCall(() => chrome.runtime.sendMessage({
          type: "set-settings",
          settings: settings
        }));
      } catch (error) {
        console.log('TransKit: Error saving settings:', error.message);
        return;
      }
      
      // Show success toast
      const enabledText = i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled";
      const forText = i18n.t("toast.for") || "for";
      showToastBottomRight(`${enabledText} ${forText} ${domain}`);
      return;
    }

    // Get the domain object (it definitely exists now)
    const domain = settings.instantDomains[matchingDomainIndex];

    // Update settings
    try {
      await safeRuntimeCall(() => chrome.runtime.sendMessage({
        type: "set-settings",
        settings: settings
      }));
    } catch (error) {
      console.log('TransKit: Error updating settings:', error.message);
      return;
    }

    // Show toast notification with domain name
    const status = domain.enabled
      ? (i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled")
      : (i18n.t("toast.instantDisabled") || "Instant translate disabled");

    const forText = i18n.t("toast.for") || "for";
    showToastBottomRight(`${status} ${forText} ${domain.domain}`);

    // Clear any pending instant translation when disabling
    if (!domain.enabled && instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }

    // Dismiss current suggestion when disabling
    if (!domain.enabled && currentSuggestion) {
      currentSuggestion.destroy();
      currentSuggestion = null;
    }
  } catch (err) {
    console.error("Toggle instant domain error:", err);
    showToast(i18n.t("toast.error") || "Error toggling instant domain");
  }
}

function extractDomainFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return window.location.hostname;
  }
}

// Alias: showToastBottomRight cũng sử dụng style modern
function showToastBottomRight(message) {
  showToast(message);
}

function registerInstantToggleShortcut() {
  document.addEventListener('keydown', async (e) => {
    const settings = await getSettings();
    const shortcut = settings.instantToggleShortcut || {
      key: "I",
      ctrl: true,
      shift: true,
      alt: false
    };

    // Check if shortcut matches
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifierKey = isMac ? e.metaKey : e.ctrlKey;

    const matches =
      e.key.toUpperCase() === shortcut.key.toUpperCase() &&
      modifierKey === shortcut.ctrl &&
      e.shiftKey === shortcut.shift &&
      e.altKey === shortcut.alt;

    if (matches) {
      e.preventDefault();
      e.stopPropagation();
      await toggleInstantDomainForCurrentUrl();
    }
  }, true);
}

// ============================================
// INSTANT LABEL INDICATOR
// ============================================

function registerInstantLabelIndicator() {
  // Create label element
  const label = document.createElement('div');
  let iconUrl;
  try {
    iconUrl = isExtensionContextValid() ? chrome.runtime.getURL('assets/icons/icon-19.png') : '';
  } catch (error) {
    console.log('TransKit: Error getting icon URL for label:', error.message);
    iconUrl = '';
  }
  const labelText = document.createElement('span');

  // Create img element or fallback
  if (iconUrl) {
    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = 'TransKit';
    img.style.cssText = 'width: 14px; height: 14px; flex-shrink: 0;';
    label.appendChild(img);
  } else {
    const fallbackIcon = document.createElement('span');
    fallbackIcon.textContent = '⚡';
    fallbackIcon.style.cssText = 'width: 14px; height: 14px; flex-shrink: 0; display: inline-block; text-align: center;';
    label.appendChild(fallbackIcon);
  }
  label.appendChild(labelText);

  label.style.cssText = `
    position: fixed;
    background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
    color: white;
    padding: 3px 6px;
    border-radius: 5px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 500;
    z-index: 9999999;
    pointer-events: none;
    display: none;
    align-items: center;
    gap: 3px;
    box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25), 0 1px 3px rgba(0, 0, 0, 0.1);
    white-space: nowrap;
    backdrop-filter: blur(6px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    opacity: 0.88;
    animation: labelFadeIn 0.3s ease-out;
  `;

  document.body.appendChild(label);

  let currentSettings = null;
  let labelTimeout = null;

  // Load initial settings
  getSettings().then(s => {
    currentSettings = s;
  });

  // Update settings when they change
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.translatorSettings) {
      currentSettings = changes.translatorSettings.newValue;
    }
  });

  // Check if instant is enabled for current domain
  function isInstantEnabledForCurrentDomain() {
    if (!currentSettings || !currentSettings.instantTranslateEnabled) {
      return false;
    }

    const currentUrl = window.location.href;
    const matchingDomain = currentSettings.instantDomains.find(
      d => d.enabled && currentUrl.includes(d.domain)
    );

    return !!matchingDomain;
  }

  // Hide label function
  function hideLabel() {
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }
    label.style.transition = 'opacity 0.3s ease-out';
    label.style.opacity = '0';
    setTimeout(() => {
      label.style.display = 'none';
      label.style.transition = 'none';
      label.style.opacity = '0.88';
    }, 300);
  }

  // Show label once on focus
  function handleInputFocus(e) {
    if (!isEditableElement(e.target) || !isInstantEnabledForCurrentDomain()) {
      return;
    }

    // Clear any existing timeout
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }

    // Get input position - align left
    const rect = e.target.getBoundingClientRect();
    const offsetY = rect.top - 35; // Position above input
    const offsetX = rect.left; // Align left with input

    // Update label text with i18n
    labelText.textContent = i18n.t("label.instant") || "Instant";

    // Show label
    label.style.left = `${offsetX}px`;
    label.style.top = `${offsetY}px`;
    label.style.display = 'flex';
    label.style.opacity = '0.88';
    label.style.transition = 'none';

    // Auto-hide after 3.5 seconds
    labelTimeout = setTimeout(() => {
      hideLabel();
    }, 3500);

    // Hide on blur
    const handleBlur = () => {
      hideLabel();
      e.target.removeEventListener('blur', handleBlur);
    };
    e.target.addEventListener('blur', handleBlur);
  }

  // Add focus listener on document (capture phase)
  document.addEventListener('focus', handleInputFocus, true);
}

// ============================================
// SELECT-TO-TRANSLATE MODE
// ============================================

function showTranslateIcon(x, y, selection) {
  hideTranslateIcon();
  
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('TransKit: Extension context invalidated, skipping icon creation');
    return;
  }
  
  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    const icon = document.createElement('div');
    icon.className = 'bt-translate-icon bt-vars-container';
    
    // Use extension icon instead of SVG
    let iconUrl;
    try {
      iconUrl = isExtensionContextValid() ? chrome.runtime.getURL('assets/icons/icon-32.png') : '';
    } catch (error) {
      console.log('TransKit: Error getting icon URL for translate icon:', error.message);
      iconUrl = '';
    }
    
    if (iconUrl) {
      icon.innerHTML = `<img src="${iconUrl}" width="24" height="24" alt="Translate" />`;
    } else {
      icon.innerHTML = `<span style="font-size: 24px; width: 24px; height: 24px; display: inline-block; text-align: center;">🔄</span>`;
    }
    
    icon.style.position = 'fixed';
    icon.style.zIndex = '9999999999';
    
    // Position near cursor - choose top or bottom based on viewport
    const viewport = getAvailableViewport();
    const spaceBelow = viewport.height - y;
    const spaceAbove = y;
    
    // If more space below, show below cursor; otherwise show above
    if (spaceBelow > 200 || spaceBelow > spaceAbove) {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y + 12}px`;
      icon.dataset.position = 'bottom';
    } else {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y - 48}px`;
      icon.dataset.position = 'top';
    }
    
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      // Pass selection rect instead of icon rect for better positioning
      showTranslationPopup(rect, selectedText, icon.dataset.position);
    });
    
    document.body.appendChild(icon);
    selectionIcon = icon;
  } catch (error) {
    console.log('TransKit: Error creating translate icon:', error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes('Extension context invalidated')) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslateIcon() {
  if (selectionIcon) {
    selectionIcon.remove();
    selectionIcon = null;
  }
}

// Helper function to get actual available viewport considering panels/devtools
function getAvailableViewport() {
  // Get the document's visible area
  const documentElement = document.documentElement;
  const body = document.body;
  
  // Calculate actual available space
  // Use document.documentElement.clientWidth/Height which excludes scrollbars
  // and is more accurate for content positioning
  const availableWidth = Math.min(
    window.innerWidth,
    documentElement.clientWidth,
    body ? body.clientWidth : window.innerWidth
  );
  
  const availableHeight = Math.min(
    window.innerHeight,
    documentElement.clientHeight,
    body ? body.clientHeight : window.innerHeight
  );
  
  // Also consider if there are any fixed elements that might reduce available space
  // Check for common panel/sidebar patterns
  const rightPanels = document.querySelectorAll('[style*="position: fixed"][style*="right: 0"], .devtools-panel, .sidebar-panel');
  const leftPanels = document.querySelectorAll('[style*="position: fixed"][style*="left: 0"], .left-panel');
  
  let rightOffset = 0;
  let leftOffset = 0;
  
  rightPanels.forEach(panel => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rightOffset = Math.max(rightOffset, rect.width);
    }
  });
  
  leftPanels.forEach(panel => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      leftOffset = Math.max(leftOffset, rect.width);
    }
  });
  
  return {
    width: Math.max(300, availableWidth - rightOffset - leftOffset), // Minimum 300px
    height: Math.max(200, availableHeight), // Minimum 200px
    leftOffset: leftOffset,
    rightOffset: rightOffset
  };
}

// Helper function to safely make chrome.runtime calls
async function safeRuntimeCall(callback) {
  if (!isExtensionContextValid()) {
    throw new Error('Extension context invalidated');
  }
  
  try {
    return await callback();
  } catch (error) {
    if (error.message.includes('Extension context invalidated') || 
        error.message.includes('Could not establish connection') ||
        error.message.includes('receiving end does not exist')) {
      cleanupExtensionElements();
      throw new Error('Extension context invalidated');
    }
    throw error;
  }
}

// Helper function to clean up extension elements when context is invalidated
function cleanupExtensionElements() {
  try {
    // Remove any existing popups or icons
    if (typeof hideTranslationPopup === 'function') {
      hideTranslationPopup();
    }
    if (typeof hideTranslateIcon === 'function') {
      hideTranslateIcon();
    }
    
    // Remove any inline suggestions
    if (typeof hideSuggestion === 'function') {
      hideSuggestion();
    }
    
    // Clear current suggestion
    if (currentSuggestion) {
      try {
        currentSuggestion.destroy();
      } catch (e) {
        // Ignore errors during cleanup
      }
      currentSuggestion = null;
    }
    
    // Clear timers
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    
    if (instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }
    
    // Clear any global timers
    if (window.transkitCleanupTimer) {
      clearTimeout(window.transkitCleanupTimer);
      window.transkitCleanupTimer = null;
    }
    
    // Remove event listeners if they exist
    if (currentKeyHandler) {
      try {
        window.removeEventListener("keydown", currentKeyHandler, true);
        window.removeEventListener("keyup", currentKeyHandler, true);
        document.removeEventListener("keydown", currentKeyHandler, true);
        document.removeEventListener("keyup", currentKeyHandler, true);
      } catch (e) {
        // Ignore errors during cleanup
      }
      currentKeyHandler = null;
    }
    
    // Remove any extension-created elements
    const extensionElements = document.querySelectorAll('.bt-inline-suggestion, .bt-selection-popup, .bt-selection-icon, .bt-toast-notify, .bt-hover-popup');
    extensionElements.forEach(el => {
      try {
        el.remove();
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    
    console.log('TransKit: Cleaned up extension elements due to context invalidation');
  } catch (error) {
    // Ignore cleanup errors - we're already in an error state
    console.log('TransKit: Error during cleanup (ignored):', error.message);
  }
}

// Helper function to check if extension context is valid
function isExtensionContextValid() {
  try {
    // Check if chrome.runtime exists and has an id
    if (!chrome || !chrome.runtime || !chrome.runtime.id) {
      return false;
    }
    
    // Try to access a runtime property to ensure context is truly valid
    chrome.runtime.getURL('test');
    return true;
  } catch (error) {
    return false;
  }
}

// Helper function to ensure popup stays within viewport bounds
function ensurePopupInViewport(popup, selectionRect) {
  const rect = popup.getBoundingClientRect();
  const viewport = getAvailableViewport();
  
  let adjustedLeft = parseFloat(popup.style.left);
  let positionChanged = false;
  
  // Adjust horizontal position if popup goes off-screen
  // Consider left and right offsets from panels
  const maxRight = viewport.width + viewport.leftOffset - 10;
  const minLeft = viewport.leftOffset + 10;
  
  if (rect.right > maxRight) {
    adjustedLeft = maxRight - rect.width;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }
  if (rect.left < minLeft) {
    adjustedLeft = minLeft;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }
  
  // Recalculate arrow position if horizontal position changed
  if (positionChanged && selectionRect) {
    const selectionCenter = selectionRect.left + (selectionRect.width / 2);
    const newArrowLeft = selectionCenter - adjustedLeft;
    // Ensure arrow stays within popup bounds (at least 20px from edges)
    const clampedArrowLeft = Math.max(20, Math.min(newArrowLeft, rect.width - 20));
    popup.style.setProperty('--bt-arrow-left', `${clampedArrowLeft}px`);
  }
  
  // Adjust vertical position if popup goes off-screen
  if (popup.style.top && rect.bottom > viewport.height - 10) {
    // If using top positioning and popup goes below viewport
    const newTop = Math.max(10, viewport.height - rect.height - 10);
    popup.style.top = `${newTop}px`;
  }
  
  if (popup.style.bottom && rect.top < 10) {
    // If using bottom positioning and popup goes above viewport
    const newBottom = Math.max(10, viewport.height - rect.height - 10);
    popup.style.bottom = `${newBottom}px`;
  }
}

// Helper function to readjust popup position after content is loaded
function readjustPopupAfterContentLoad(popup, selectionRect) {
  // Wait a bit for content to render, then readjust
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 100);
  
  // Also readjust after a longer delay to catch any async content loading
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 500);
}

async function showTranslationPopup(selectionRect, text, iconPosition) {
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.log('TransKit: Extension context invalidated, cannot show popup');
    return;
  }
  
  try {
    hideTranslationPopup();

    // Fetch settings first to ensure i18n is updated
    const settings = await getSettings();
    
    const popup = document.createElement('div');
    let iconUrl;
    try {
      iconUrl = isExtensionContextValid() ? chrome.runtime.getURL('assets/icons/icon-19.png') : '';
    } catch (error) {
      console.log('TransKit: Error getting icon URL for popup:', error.message);
      iconUrl = '';
    }
    popup.className = 'bt-selection-popup bt-vars-container';
  popup.innerHTML = `
    <div class="bt-selection-bg-pattern"></div>
    <div class="bt-selection-header">
      <span class="bt-selection-title">
        ${iconUrl ? `<img src="${iconUrl}" width="19" height="19" alt="Translate" style="float:left;margin-right:4px" />` : '<span style="float:left;margin-right:4px;font-size:19px;">🔄</span>'} 
        <span>${i18n.t("selection.title")}</span>
      </span>
      <button class="bt-selection-close">×</button>
    </div>
    <div class="bt-selection-content">
      <div class="bt-selection-original">
        <label>
          ${i18n.t("selection.original")}
          <select class="bt-selection-source-select"></select>
        </label>
        <div class="bt-selection-text-container bt-selection-content-style">
          <button class="bt-speak-btn bt-speak-source" title="Listen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
          </button>
          <div class="bt-selection-text-content">${text}</div>
        </div>
      </div>
      <div class="bt-selection-translated">
        <label>
          ${i18n.t("selection.translate")}
          <select class="bt-selection-target-select"></select>
        </label>
        <div class="bt-selection-result-container">
          <div class="bt-selection-text-container bt-selection-content-style">
            <button class="bt-speak-btn bt-speak-target" title="Listen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
            </button>
            <div class="bt-selection-text-content bt-loading-text">${i18n.t("dialog.translating")}</div>
          </div>
          <button class="bt-selection-copy-btn" title="${i18n.t("selection.copy")}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="bt-copy-feedback">${i18n.t("selection.copied")}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="bt-selection-footer">
      <div class="bt-selection-provider-container">
        <!-- Provider selector or label will be injected here -->
      </div>
      <a href="#" class="bt-selection-settings">${i18n.t("selection.settings")}</a>
    </div>
  `;
  
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999999999';
  
  // Center popup based on SELECTION rect
  // First, add popup to DOM to get actual dimensions
  document.body.appendChild(popup);
  const tempRect = popup.getBoundingClientRect();
  const actualPopupWidth = tempRect.width;
  
  // Get available viewport considering panels
  const viewport = getAvailableViewport();
  
  const selectionCenter = selectionRect.left + (selectionRect.width / 2);
  const left = selectionCenter - (actualPopupWidth / 2);
  
  // Ensure popup doesn't go off-screen horizontally
  // Consider panel offsets
  const maxLeft = viewport.width + viewport.leftOffset - actualPopupWidth - 10;
  const minLeft = viewport.leftOffset + 10;
  const finalLeft = Math.max(minLeft, Math.min(left, maxLeft));
  
  // Calculate arrow position relative to popup
  // Arrow should point to selection center
  const arrowLeft = selectionCenter - finalLeft;
  popup.style.setProperty('--bt-arrow-left', `${arrowLeft}px`);
  
  // Vertical positioning: close to selection with overflow check
  // Get initial popup dimensions after adding to DOM
  const initialRect = popup.getBoundingClientRect();
  
  // Estimate final popup height (accounting for content that will be loaded)
  // Use a more conservative estimate since content will be added
  const estimatedPopupHeight = Math.max(initialRect.height, 200); // Minimum 200px for safety
  
  // Calculate available space above and below selection
  const spaceAbove = selectionRect.top;
  const spaceBelow = viewport.height - selectionRect.bottom;
  
  // Determine best position based on available space and estimated popup height
  let finalPosition = iconPosition;
  
  if (iconPosition === 'bottom') {
    // Check if popup fits below selection with some buffer
    if (selectionRect.bottom + 8 + estimatedPopupHeight > viewport.height - 20) {
      // Not enough space below, check if there's more space above
      if (spaceAbove > spaceBelow && spaceAbove >= estimatedPopupHeight + 28) {
        finalPosition = 'top';
      }
    }
  } else {
    // Check if popup fits above selection with some buffer
    if (selectionRect.top - 8 - estimatedPopupHeight < 20) {
      // Not enough space above, check if there's more space below
      if (spaceBelow > spaceAbove && spaceBelow >= estimatedPopupHeight + 28) {
        finalPosition = 'bottom';
      }
    }
  }
  
  // Apply final positioning with better calculations
  if (finalPosition === 'bottom') {
    popup.style.left = `${finalLeft}px`;
    // Ensure popup doesn't go below viewport, with extra buffer
    const maxTop = viewport.height - estimatedPopupHeight - 20;
    popup.style.top = `${Math.min(selectionRect.bottom + 8, maxTop)}px`;
    popup.classList.add('bt-popup-bottom');
    popup.classList.remove('bt-popup-top');
  } else {
    popup.style.left = `${finalLeft}px`;
    // Ensure popup doesn't go above viewport, with extra buffer
    const maxBottom = viewport.height - selectionRect.top + 8;
    const minBottom = estimatedPopupHeight + 20;
    popup.style.bottom = `${Math.min(maxBottom, viewport.height - minBottom)}px`;
    popup.classList.add('bt-popup-top');
    popup.classList.remove('bt-popup-bottom');
  }
  selectionPopup = popup;
  
  // Store selectionRect for later use in readjustment
  popup._selectionRect = selectionRect;

  // Ensure popup stays within viewport bounds after positioning
  ensurePopupInViewport(popup, selectionRect);
  
  // Schedule readjustment after content loads
  readjustPopupAfterContentLoad(popup, selectionRect);
  
  // Final arrow position adjustment is now handled in ensurePopupInViewport

  // Make draggable
  const header = popup.querySelector('.bt-selection-header');
  makeDraggable(popup, header);
  
  // Hide icon when popup opens
  hideTranslateIcon();
  
  // Populate selectors (Mirror Logic)
  const nativeLang = settings.nativeLanguageCode || 'vi';
  const targetLang = settings.targetLanguageCode || 'en';
  
  let defaultSource, defaultTarget;
  
  if (!settings.useAutoDetect) { // Fixed direction (Mirror Logic)
    defaultSource = targetLang;
    defaultTarget = nativeLang;
  } else {
    // Auto-detect mode
    defaultSource = 'auto';
    defaultTarget = targetLang;
  }

  // Override with last used selection languages if available
  if (settings.selectionLastSource) {
    defaultSource = settings.selectionLastSource;
  }
  if (settings.selectionLastTarget) {
    defaultTarget = settings.selectionLastTarget;
  }
  
  // Populate selectors
  populateLanguageSelector(popup.querySelector('.bt-selection-source-select'), defaultSource, true);
  populateLanguageSelector(popup.querySelector('.bt-selection-target-select'), defaultTarget, false);
  
  // Initial translation
  translateSelectionWithSource(text, defaultSource, popup, null, defaultTarget);
  
  popup.querySelector('.bt-selection-close').addEventListener('click', () => {
    hideTranslationPopup();
    hideTranslateIcon();
  });
  
  popup.querySelector('.bt-selection-source-select').addEventListener('change', (e) => {
    const providerSelect = popup.querySelector('.bt-selection-provider-select');
    const providerId = providerSelect ? providerSelect.value : null;
    const targetLang = popup.querySelector('.bt-selection-target-select').value;
    
    // Save preference
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ 
        type: 'set-settings', 
        settings: { ...settings, selectionLastSource: e.target.value } 
      }));
    } catch (error) {
      console.log('TransKit: Error saving source preference:', error.message);
    }

    translateSelectionWithSource(text, e.target.value, popup, providerId, targetLang);
  });

  popup.querySelector('.bt-selection-target-select').addEventListener('change', (e) => {
    const providerSelect = popup.querySelector('.bt-selection-provider-select');
    const providerId = providerSelect ? providerSelect.value : null;
    const sourceLang = popup.querySelector('.bt-selection-source-select').value;

    // Save preference
    console.log('Saving selectionLastTarget:', e.target.value);
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ 
        type: 'set-settings', 
        settings: { ...settings, selectionLastTarget: e.target.value } 
      }));
    } catch (error) {
      console.log('TransKit: Error saving target preference:', error.message);
    }

    translateSelectionWithSource(text, sourceLang, popup, providerId, e.target.value);
  });

  // Populate provider selector
  const providerSelect = populateProviderSelector(popup, settings);
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      const sourceLang = popup.querySelector('.bt-selection-source-select').value;
      const targetLang = popup.querySelector('.bt-selection-target-select').value;
      translateSelectionWithSource(text, sourceLang, popup, e.target.value, targetLang);
    });
  }
  
  // Settings link
  popup.querySelector('.bt-selection-settings').addEventListener('click', (e) => {
    e.preventDefault();
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ type: 'open-options' }));
    } catch (error) {
      console.log('TransKit: Error opening options:', error.message);
    }
  });

  // Copy button
  const copyBtn = popup.querySelector('.bt-selection-copy-btn');
  copyBtn.addEventListener('click', async () => {
    const textToCopy = popup.querySelector('.bt-selection-translated .bt-selection-text-content').textContent;
    if (!textToCopy || textToCopy === i18n.t("dialog.translating")) return;

    try {
      await navigator.clipboard.writeText(textToCopy);
      copyBtn.classList.add('bt-copied');
      setTimeout(() => copyBtn.classList.remove('bt-copied'), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });
  


  // TTS Handlers
  popup.querySelector('.bt-speak-source').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('bt-speak-loading')) return;

    const sourceLang = popup.querySelector('.bt-selection-source-select').value;
    const textToSpeak = text; // Original text
    
    btn.classList.add('bt-speak-loading');
    try {
      await tts.play(textToSpeak, sourceLang === 'auto' ? 'en' : sourceLang);
    } catch (err) {
      console.error("TTS Error:", err);
    } finally {
      btn.classList.remove('bt-speak-loading');
    }
  });

  popup.querySelector('.bt-speak-target').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('bt-speak-loading')) return;

    const targetLang = popup.querySelector('.bt-selection-target-select').value;
    const textToSpeak = popup.querySelector('.bt-selection-translated .bt-selection-text-content').textContent;
    
    if (textToSpeak && textToSpeak !== i18n.t("dialog.translating")) {
      btn.classList.add('bt-speak-loading');
      try {
        await tts.play(textToSpeak, targetLang);
      } catch (err) {
        console.error("TTS Error:", err);
      } finally {
        btn.classList.remove('bt-speak-loading');
      }
    }
  });

  } catch (error) {
    console.log('TransKit: Error showing translation popup:', error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes('Extension context invalidated')) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslationPopup() {
  if (selectionPopup) {
    selectionPopup.remove();
    selectionPopup = null;
  }
}

async function translateSelectionWithSource(text, sourceLang, popup, providerId = null, targetLangOverride = null) {
  const settings = await getSettings();
  const nativeLang = settings.nativeLanguageCode || 'vi';
  const targetLang = targetLangOverride || nativeLang;
  
  const translatedDiv = popup.querySelector('.bt-selection-translated .bt-selection-text-content');
  
  translatedDiv.textContent = i18n.t("dialog.translating");
  translatedDiv.classList.add('bt-loading-text');
  
  // If source and target are the same, return original text immediately
  if (sourceLang !== 'auto' && sourceLang === targetLang) {
    translatedDiv.textContent = text;
    translatedDiv.classList.remove('bt-loading-text');
    // Readjust popup position after content change
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
    return;
  }
  
  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: nativeLang,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang, // Pass explicit source language
      useAutoDetect: sourceLang === 'auto' ? true : (settings.useAutoDetect === true),
      providerId: providerId // Pass provider override
    });
    
    if (res?.ok && res.result?.translation) {
      translatedDiv.textContent = res.result.translation;
      translatedDiv.classList.remove('bt-loading-text');
    } else {
      // Show actual error message from background/provider
      translatedDiv.textContent = res?.error || i18n.t("toast.translationFailed");
      translatedDiv.classList.remove('bt-loading-text');
    }
    
    // Readjust popup position after content is loaded
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
    
  } catch (err) {
    translatedDiv.textContent = 'Error: ' + err.message;
    translatedDiv.classList.remove('bt-loading-text');
    // Readjust popup position even on error
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
  }
}

function populateLanguageSelector(popup) {
  const select = popup.querySelector('.bt-selection-lang-select');
  const languages = [
    'vi', 'en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'
  ];
  
  languages.forEach(code => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = i18n.t("lang." + code);
    select.appendChild(option);
  });
  
  getSettings().then(settings => {
    select.value = settings.nativeLanguageCode || 'vi';
  });
}

let lastPopupCloseTime = 0;

function registerSelectionMode() {
  document.addEventListener('mouseup', (e) => {
    // Ignore if clicking on icon or popup
    if (e.target.closest('.bt-translate-icon') || e.target.closest('.bt-selection-popup')) {
      return;
    }

    // Ignore if we just closed the popup (within 200ms)
    if (Date.now() - lastPopupCloseTime < 200) {
      return;
    }

    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      
      if (text && text.length > 0) {
        // If popup is already open for this text, don't show icon
        if (selectionPopup && selectedText === text) {
          return;
        }
        
        selectedText = text;
        showTranslateIcon(e.clientX, e.clientY, selection);
      } else {
        hideTranslateIcon();
        // Don't hide popup here, let mousedown handle it (so we can copy text from popup)
      }
    }, 10);
  });
  
  document.addEventListener('mousedown', (e) => {
    // 1. Handle Popup Open State
    if (selectionPopup) {
      if (!selectionPopup.contains(e.target)) {
        // Clicked outside popup
        // Prevent default to PRESERVE selection
        e.preventDefault();
        e.stopPropagation();
        hideTranslationPopup();
        lastPopupCloseTime = Date.now();
      }
      return;
    }

    // 2. Handle Icon Open State (Popup is closed)
    if (selectionIcon) {
      if (!selectionIcon.contains(e.target)) {
        // Clicked outside icon
        // Let default behavior happen (selection clears)
        hideTranslateIcon();
      }
    }
  });
}

function populateLanguageSelector(select, defaultValue = 'auto', includeAuto = true) {
  if (!select) return;
  
  const languages = includeAuto 
    ? ['auto', 'en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de']
    : ['en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de'];
  
  languages.forEach(code => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = i18n.t("lang." + code);
    select.appendChild(option);
  });
  
  select.value = defaultValue;
}

function populateProviderSelector(popup, settings) {
  const container = popup.querySelector('.bt-selection-provider-container');
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || 'builtin';

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: 'Chrome Built-in AI' };
    const tag = document.createElement('span');
    tag.className = 'bt-selection-provider-tag';
    tag.textContent = `Model: ${provider.name}`;
    container.appendChild(tag);
  } else {
    // Show as a select dropdown
    const label = document.createElement('span');
    label.className = 'bt-selection-provider-label';
    label.textContent = 'Model: ';
    
    const select = document.createElement('select');
    select.className = 'bt-selection-provider-select';
    
    providers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });
    
    container.appendChild(label);
    container.appendChild(select);
    
    return select;
  }
  return null;
}

function getLanguageName(code) {
  return i18n.t("lang." + code) || code.toUpperCase();
}

function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  handle.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    e = e || window.event;
    // Only allow left click
    if (e.button !== 0) return;
    
    // Don't drag if clicking on the close button
    if (e.target.closest('.bt-selection-close')) return;

    e.preventDefault();
    
    // Convert bottom/right to top/left if needed for consistent math
    const rect = element.getBoundingClientRect();
    element.style.bottom = 'auto';
    element.style.right = 'auto';
    element.style.top = rect.top + 'px';
    element.style.left = rect.left + 'px';

    // Get the mouse cursor position at startup
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    // Call a function whenever the cursor moves
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // Calculate the new cursor position
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // Set the element's new position
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
    
    // Remove arrow class when dragged to avoid visual artifacts
    element.classList.remove('bt-popup-top', 'bt-popup-bottom');
  }

  function closeDragElement() {
    // Stop moving when mouse button is released
    document.onmouseup = null;
    document.onmousemove = null;
  }
}
// Hover translate state
let hoverModifierPressed = false;
let hoverTranslateCache = new Map();
let currentHoveredElement = null;
let hoverTimeout = null;
let lastMouseX = 0;
let lastMouseY = 0;

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, { passive: true });

function registerHoverTranslate() {

  
  // Track modifier key state
  document.addEventListener('keydown', async (e) => {

    
    const settings = await getSettings();

    
    if (!settings.hoverTranslateEnabled) {

      return;
    }
    
    const isOnDomain = isHoverTranslateDomain(settings);

    if (!isOnDomain) {

      return;
    }
    
    const key = settings.hoverModifierKey || 'ctrl';

    if (
      (key === 'ctrl' && e.ctrlKey) ||
      (key === 'shift' && e.shiftKey) ||
      (key === 'alt' && e.altKey)
    ) {

      hoverModifierPressed = true;
      document.body.classList.add('bt-hover-translate-active');
      
      // Apply custom styles
      applyHoverCustomStyles(settings.hoverInjectStyle);
      
      // Trigger translation or toggle if already hovering over an element
      const element = document.elementFromPoint(lastMouseX, lastMouseY);
      if (element) {
        // Check if hovering over a translation or an already translated element
        const translationEl = element.closest('.bt-hover-translation');
        const originalEl = element.closest('[data-bt-translated="true"]');
        
        if (translationEl) {
          // Hovering over translation -> Close it

          const prev = translationEl.previousElementSibling;
          if (prev && prev.dataset.btTranslated) {
            delete prev.dataset.btTranslated;
            prev.classList.remove('bt-hover-original');
          }
          translationEl.remove();
          return;
        }
        
        if (originalEl) {
          // Hovering over original that is already translated -> Close it

          const next = originalEl.nextElementSibling;
          if (next && next.classList.contains('bt-hover-translation')) {
            next.remove();
          }
          delete originalEl.dataset.btTranslated;
          originalEl.classList.remove('bt-hover-original');
          return;
        }


        const translatable = findTranslatableElement(element);
        if (translatable) {

          
          // Unique Mode: Clear all other translations if enabled
          // Note: We also check this inside handleHoverTranslate for mouseover events
          if (settings.hoverUniqueMode !== false) {
             clearAllHoverTranslations();
          }
          
          handleHoverTranslate(translatable, settings);
        }
      }
    }
  }, true);

  document.addEventListener('keyup', async (e) => {
    const settings = await getSettings();
    const key = settings.hoverModifierKey || 'ctrl';
    
    if (
      (key === 'ctrl' && !e.ctrlKey) ||
      (key === 'shift' && !e.shiftKey) ||
      (key === 'alt' && !e.altKey)
    ) {

      hoverModifierPressed = false;
      document.body.classList.remove('bt-hover-translate-active');
      // clearAllHoverTranslations(); // Don't clear on key release
    }
  }, true);

  // Hover detection with debouncing
  document.addEventListener('mouseover', async (e) => {

    
    if (!hoverModifierPressed) return;
    

    const settings = await getSettings();
    if (!isHoverTranslateDomain(settings)) {

      return;
    }
    

    clearTimeout(hoverTimeout);
    const element = findTranslatableElement(e.target);
    
    if (!element) {

      return;
    }
    if (element === currentHoveredElement) {

      return;
    }
    

    currentHoveredElement = element;
    hoverTimeout = setTimeout(() => {

      handleHoverTranslate(element, settings);
    }, 200);
  }, true);

  document.addEventListener('mouseout', () => {
    clearTimeout(hoverTimeout);
  }, true);
}

/**
 * Check if element is a translation boundary (should not traverse beyond)
 * Boundaries are containers for individual messages/content blocks on chat platforms
 */
function isTranslationBoundary(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

  // Discord: message content divs have class containing 'messageContent' or ID starting with 'message-content-'
  const className = element.className || '';
  const id = element.id || '';

  // Check Discord patterns
  if (className.includes('messageContent') || id.startsWith('message-content-')) {
    return true;
  }

  // Slack: message blocks
  if (className.includes('p-rich_text_section') || className.includes('c-message__body')) {
    return true;
  }

  // Telegram Web: message bubbles
  if (className.includes('message-content') || className.includes('text-content')) {
    return true;
  }

  // Generic: data attributes that might indicate message boundaries
  if (element.hasAttribute('data-message-id') || element.hasAttribute('data-msg-id')) {
    return true;
  }

  return false;
}

/**
 * Find the nearest boundary ancestor (if any)
 */
function findBoundaryAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isTranslationBoundary(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findTranslatableElement(target) {
  let element = target;
  let depth = 0;
  const maxDepth = 5;

  // Find boundary first - we should not traverse beyond this
  const boundary = findBoundaryAncestor(target);

  while (element && depth < maxDepth) {
    // CRITICAL: If we have a boundary, never go beyond it
    // Check if current element is at or beyond the boundary
    if (boundary) {
      // If we've reached the boundary's parent, stop and return boundary
      if (element === boundary.parentElement || !boundary.contains(element)) {
        return boundary;
      }
    }

    // Ignore our own translation elements
    if (element.classList.contains('bt-hover-translation')) return null;

    // Ignore interactive elements to avoid conflict
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(element.tagName)) {
       // Unless it's a link with significant text, maybe? For now, skip to avoid issues.
       // Actually, users might want to translate links. Let's allow A if it has text.
       if (element.tagName !== 'A') {
         element = element.parentElement;
         depth++;
         continue;
       }
    }

    const text = element.textContent?.trim();

    if (text && text.length > 2 && text.length < 2000) { // Adjusted limits
      const tagName = element.tagName?.toLowerCase();
      // Block-level elements only (removed 'span', 'a', 'b', 'i' to prioritize containers)
      if (['div', 'p', 'article', 'section', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'].includes(tagName)) {

        // If this element IS the boundary, return it directly (skip container checks)
        if (boundary && element === boundary) {
          return element;
        }

        // Smart check: If it's a DIV/SECTION, ensure it's not just a container of other blocks
        // We prefer "leaf" blocks or blocks with mostly text
        if (['div', 'section', 'article'].includes(tagName)) {
           const childBlockCount = element.querySelectorAll('div, p, section, article, li').length;
           // If it has too many block children, it's likely a container. Skip it unless it has direct text.
           if (childBlockCount > 3) {
             // Check if it has significant direct text
             const directText = Array.from(element.childNodes)
               .filter(n => n.nodeType === Node.TEXT_NODE)
               .map(n => n.textContent.trim())
               .join('');
             if (directText.length < 50) {
               // If this would take us beyond boundary, return boundary instead
               if (boundary && (element.parentElement === boundary.parentElement || !boundary.contains(element.parentElement))) {
                 return boundary;
               }
               element = element.parentElement;
               depth++;
               continue;
             }
           }
        }

        const textNodes = Array.from(element.childNodes).filter(
          n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );

        // Allow if it has text nodes OR is a small container
        if (textNodes.length > 0 || element.children.length <= 3) {
          // LIST PROMOTION: If we found a list item, select the whole list
          // BUT NOT if there's a boundary - in chat apps, each LI is a separate message
          if (['LI', 'DT', 'DD'].includes(element.tagName)) {
             // If we have a boundary ancestor, don't promote - return the boundary
             if (boundary) {
               return boundary;
             }
             return element.closest('ul, ol, dl') || element.parentElement;
          }
          return element;
        }
      }
    }

    element = element.parentElement;
    depth++;
  }

  // If we have a boundary but didn't find suitable element, return boundary
  if (boundary) {
    return boundary;
  }

  return null;
}

async function handleHoverTranslate(element, settings) {
  // Always use innerHTML to capture any potential formatting
  const text = element.innerHTML?.trim();

  if (!text) {
    return;
  }
  
  // Log parent element info for debugging
  console.log('[Hover] Target:', element.tagName, 'Granularity:', settings.hoverTranslateGranularity || 'line');

  // Get granularity setting (default: 'line')
  const granularity = settings.hoverTranslateGranularity || 'line';
  
  // Unique Mode Check (Fix: Moved inside handler to catch mouseover events)
  if (settings.hoverUniqueMode !== false) {
    clearAllHoverTranslations();
  }

  // Route to appropriate translation method based on granularity
  if (granularity === 'line') {
    return handleLineByLineTranslate(
      element, text, settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      hoverTranslateCache,
      clearAllHoverTranslations
    );
  } else if (granularity === 'sentence') {
    return handleSentenceBySentenceTranslate(
      element, text, settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      hoverTranslateCache,
      clearAllHoverTranslations
    );
  }
  
  // Default: Block mode (existing behavior)
  // Create placeholder immediately
  const placeholder = createHoverPlaceholder(element, settings);
  
  // Include providerId in cache key to support provider switching
  const cacheKey = `${text}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;
  if (hoverTranslateCache.has(cacheKey)) {
    updateHoverContent(placeholder, hoverTranslateCache.get(cacheKey), settings);
    return;
  }
  
  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.nativeLanguageCode || "vi", // Translate TO native language
      sourceLanguage: settings.targetLanguageCode || "en", // FROM target language (e.g., English web content)
      useAutoDetect: false // Fixed Target→Native for hover
    });
    
    if (res?.ok && res.result?.translation) {
      const translation = res.result.translation;
      hoverTranslateCache.set(cacheKey, translation);
      updateHoverContent(placeholder, translation, settings);
    } else {
      // Show error inline instead of removing
      updateHoverContent(placeholder, `❌ ${res?.error || 'Translation failed'}`, settings, true);
    }
  } catch (err) {
    // Show error inline instead of removing
    updateHoverContent(placeholder, `❌ ${err.message || 'Error'}`, settings, true);
  }
}

function createHoverPlaceholder(element, settings) {
  // Check if already exists
  let existing = element.nextElementSibling;
  if (existing && existing.classList.contains('bt-hover-translation')) {
    return existing;
  }

  // Create element of the same tag to mimic structure
  const translationEl = document.createElement(element.tagName);
  translationEl.className = 'bt-hover-translation';
  
  // Copy styles from original element to look like a clone
  const computedStyle = window.getComputedStyle(element);
  
  // Copy text styles
  translationEl.style.fontFamily = computedStyle.fontFamily;
  translationEl.style.fontSize = settings.hoverInjectStyle?.fontSize || computedStyle.fontSize;
  translationEl.style.fontWeight = computedStyle.fontWeight;
  translationEl.style.fontStyle = computedStyle.fontStyle;
  translationEl.style.lineHeight = computedStyle.lineHeight;
  translationEl.style.textAlign = computedStyle.textAlign;
  translationEl.style.letterSpacing = computedStyle.letterSpacing;
  
  // Color Logic:
  // Always transparent background.
  // Use user's textColor (default Red #ff0000).
  translationEl.style.backgroundColor = 'transparent';
  translationEl.style.color = settings.hoverInjectStyle?.textColor || '#ff0000';
  
  // Copy layout styles
  translationEl.style.padding = computedStyle.padding;
  translationEl.style.margin = computedStyle.margin;
  translationEl.style.marginTop = '4px'; // Add slight separation
  translationEl.style.width = computedStyle.width !== 'auto' ? computedStyle.width : '100%';
  translationEl.style.boxSizing = 'border-box';
  
  // Ensure block display for proper positioning below
  translationEl.style.display = 'block';
  
  const style = settings.hoverInjectStyle || {};
  if (style.underline) {
    translationEl.classList.add('bt-hover-underline');
  }
  
  // Add TransKit Icon at start (if enabled)
  if (style.showIcon !== false) {
    let iconSrc;
    try {
      iconSrc = isExtensionContextValid() ? chrome.runtime.getURL('assets/icons/icon-19.png') : '';
    } catch (error) {
      console.log('TransKit: Error getting icon URL for hover:', error.message);
      iconSrc = '';
    }
    
    if (iconSrc) {
      const icon = document.createElement('img');
      icon.src = iconSrc; // Use small icon
      icon.className = 'bt-hover-icon';
      icon.style.width = '14px';
      icon.style.height = '14px';
      icon.style.verticalAlign = 'middle';
      icon.style.marginRight = '6px';
      icon.style.display = 'inline-block';
      translationEl.appendChild(icon);
    } else {
      const fallbackIcon = document.createElement('span');
      fallbackIcon.textContent = '🔄';
      fallbackIcon.className = 'bt-hover-icon';
      fallbackIcon.style.width = '14px';
      fallbackIcon.style.height = '14px';
      fallbackIcon.style.verticalAlign = 'middle';
      fallbackIcon.style.marginRight = '6px';
      fallbackIcon.style.display = 'inline-block';
      fallbackIcon.style.fontSize = '12px';
      translationEl.appendChild(fallbackIcon);
    }
  }

  // Add modern CSS spinner instead of GIF
  const loadingSpinner = document.createElement('span');
  loadingSpinner.className = 'bt-spinner';
  translationEl.appendChild(loadingSpinner);
  
  translationEl.dataset.btInjected = 'true';
  
  // Ensure original element handles the insertion correctly
  // if (computedStyle.display === 'inline') {
  //   element.style.display = 'inline-block';
  // }
  
  element.insertAdjacentElement('afterend', translationEl);
  // element.classList.add('bt-hover-original'); // Keep natural
  
  return translationEl;
}

function updateHoverContent(element, translation, settings, isError = false) {
  // Keep the TransKit icon
  const icon = element.querySelector('.bt-hover-icon');
  
  element.innerHTML = ''; // Clear content
  if (icon) element.appendChild(icon);
  
  // Append translation text with HTML formatting
  const textSpan = document.createElement('span');
  textSpan.innerHTML = translation; // Use innerHTML to render HTML tags
  element.appendChild(textSpan);
  
  // Apply error styling if needed
  if (isError) {
    element.style.color = '#dc3545'; // text-danger red
    element.style.fontWeight = 'bold';
  }
  
  // Model Label removed as per user request
}

function applyHoverTranslation(element, translation, settings) {
  console.log('[HoverTranslate] applyHoverTranslation called, mode:', settings.hoverTranslateMode);
  if (element.dataset.btTranslated) {
    console.log('[HoverTranslate] Element already translated');
    return;
  }
  element.dataset.btTranslated = 'true';
  
  const mode = settings.hoverTranslateMode || 'inject';
  
  if (mode === 'replace') {
    console.log('[HoverTranslate] Applying replace mode');
    applyReplaceMode(element, translation);
  } else {
    console.log('[HoverTranslate] Applying inject mode');
    applyInjectMode(element, translation, settings);
  }
  console.log('[HoverTranslate] Translation applied successfully');
}

function applyReplaceMode(element, translation) {
  if (!element.dataset.btOriginal) {
    element.dataset.btOriginal = element.textContent;
  }
  
  replaceTextContent(element, translation);
  element.classList.add('bt-hover-translated');
}

function applyInjectMode(element, translation, settings) {
  // Create element of the same tag to mimic structure
  const translationEl = document.createElement(element.tagName);
  translationEl.className = 'bt-hover-translation';
  
  // Copy styles from original element to look like a clone
  const computedStyle = window.getComputedStyle(element);
  
  // Copy text styles
  translationEl.style.fontFamily = computedStyle.fontFamily;
  translationEl.style.fontSize = settings.hoverInjectStyle?.fontSize || computedStyle.fontSize;
  translationEl.style.fontWeight = computedStyle.fontWeight;
  translationEl.style.fontStyle = computedStyle.fontStyle;
  translationEl.style.lineHeight = computedStyle.lineHeight;
  translationEl.style.textAlign = computedStyle.textAlign;
  translationEl.style.letterSpacing = computedStyle.letterSpacing;
  translationEl.style.color = settings.hoverInjectStyle?.textColor || computedStyle.color;
  
  // Copy layout styles
  translationEl.style.padding = computedStyle.padding;
  translationEl.style.margin = computedStyle.margin;
  translationEl.style.marginTop = '4px'; // Add slight separation
  translationEl.style.width = computedStyle.width !== 'auto' ? computedStyle.width : '100%';
  translationEl.style.boxSizing = 'border-box';
  translationEl.style.backgroundColor = settings.hoverInjectStyle?.backgroundColor || 'transparent';
  
  // Ensure block display for proper positioning below
  translationEl.style.display = 'block';
  
  const style = settings.hoverInjectStyle || {};
  
  if (!style.showIcon) {
    translationEl.classList.add('bt-hover-no-icon');
  }
  if (style.underline) {
    translationEl.classList.add('bt-hover-underline');
  }
  
  translationEl.textContent = translation;
  translationEl.dataset.btInjected = 'true';
  
  // Ensure original element handles the insertion correctly
  if (computedStyle.display === 'inline') {
    element.style.display = 'inline-block';
  }
  
  element.insertAdjacentElement('afterend', translationEl);
  element.classList.add('bt-hover-original');
}

function replaceTextContent(element, newText) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  
  if (textNodes.length > 0) {
    textNodes[0].textContent = newText;
    textNodes.slice(1).forEach(node => node.remove());
  }
}

function clearAllHoverTranslations() {
  // 1. Remove standard block translations
  document.querySelectorAll('.bt-hover-translation').forEach(el => el.remove());
  
  // 2. Remove node-based injected content (Legacy)
  document.querySelectorAll('.bt-injected-content').forEach(el => el.remove());
  
  // 3. Cleanup Wrappers (Unwrap)
  document.querySelectorAll('[data-transkit-wrapper]').forEach(wrapper => {
    const originalSpan = wrapper.querySelector('[data-transkit-original]');
    if (originalSpan) {
      // Move original text nodes back to parent
      while (originalSpan.firstChild) {
        wrapper.parentNode.insertBefore(originalSpan.firstChild, wrapper);
      }
    }
    wrapper.remove();
  });
  
  // 4. Cleanup original elements (Block mode replace)
  document.querySelectorAll('[data-bt-original]').forEach(el => {
    replaceTextContent(el, el.dataset.btOriginal);
    delete el.dataset.btOriginal;
    delete el.dataset.btTranslated;
    el.classList.remove('bt-hover-translated');
  });
  
  // 5. Cleanup granular mode markers
  document.querySelectorAll('[data-transkit-translated]').forEach(el => {
    el.removeAttribute('data-transkit-translated');
    el.classList.remove('bt-hover-translated');
  });
  
  currentHoveredElement = null;
}

function isHoverTranslateDomain(settings) {
  if (!settings.hoverTranslateEnabled) return false;
  if (!settings.hoverTranslateDomains || settings.hoverTranslateDomains.length === 0) return false;
  
  const currentUrl = window.location.href;
  return settings.hoverTranslateDomains.some(
    d => d.enabled && currentUrl.includes(d.domain)
  );
}

function applyHoverCustomStyles(style) {
  const root = document.documentElement;
  root.style.setProperty('--bt-hover-bg-color', style.backgroundColor || '#667eea');
  root.style.setProperty('--bt-hover-text-color', style.textColor || '#ffffff');
  root.style.setProperty('--bt-hover-font-size', style.fontSize || '0.95em');
  root.style.setProperty('--bt-hover-show-icon', style.showIcon !== false ? 'inline' : 'none');
}

function registerHoverToggleShortcut() {
  document.addEventListener('keydown', async (e) => {
    const settings = await getSettings();
    const shortcut = settings.hoverToggleShortcut || {
      key: "O",
      ctrl: true,
      shift: true,
      alt: false
    };

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifierKey = isMac ? e.metaKey : e.ctrlKey;

    const matches =
      e.key.toUpperCase() === shortcut.key.toUpperCase() &&
      modifierKey === shortcut.ctrl &&
      e.shiftKey === shortcut.shift &&
      e.altKey === shortcut.alt;

    if (matches) {
      e.preventDefault();
      e.stopPropagation();
      await toggleHoverDomainForCurrentUrl();
    }
  }, true);
}

async function toggleHoverDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const currentUrl = window.location.href;

    if (!settings.hoverTranslateDomains) {
      settings.hoverTranslateDomains = [];
    }

    const matchingDomainIndex = settings.hoverTranslateDomains.findIndex(
      d => currentUrl.includes(d.domain)
    );

    // If global setting is disabled, enable it and FORCE enable the domain
    if (!settings.hoverTranslateEnabled) {
      settings.hoverTranslateEnabled = true;
      
      if (matchingDomainIndex !== -1) {
        // Force enable if it exists
        settings.hoverTranslateDomains[matchingDomainIndex].enabled = true;
      }
      // If it doesn't exist, it will be added below
    } else if (matchingDomainIndex !== -1) {
      // Global is already on, so we just toggle the domain
      settings.hoverTranslateDomains[matchingDomainIndex].enabled = !settings.hoverTranslateDomains[matchingDomainIndex].enabled;
    }

    if (matchingDomainIndex === -1) {
      // Auto-add domain
      const domain = extractDomainFromUrl(currentUrl);
      
      settings.hoverTranslateDomains.push({
        domain: domain,
        enabled: true
      });
      
      try {
        await safeRuntimeCall(() => chrome.runtime.sendMessage({
          type: "set-settings",
          settings: settings
        }));
      } catch (error) {
        console.log('TransKit: Error saving hover domain settings:', error.message);
        return;
      }
      
      showToastBottomRight(`✨ Hover translate enabled for ${domain}`);
      return;
    }

    // Get the domain object
    const domain = settings.hoverTranslateDomains[matchingDomainIndex];

    try {
      await safeRuntimeCall(() => chrome.runtime.sendMessage({
        type: "set-settings",
        settings: settings
      }));
    } catch (error) {
      console.log('TransKit: Error updating hover domain settings:', error.message);
      return;
    }

    const status = domain.enabled
      ? "✨ Hover translate enabled"
      : "Hover translate disabled";

    showToastBottomRight(`${status} for ${domain.domain}`);

    if (!domain.enabled) {
      clearAllHoverTranslations();
    }
  } catch (err) {
    console.error("Toggle hover domain error:", err);
    showToast("Error toggling hover domain");
  }
}

