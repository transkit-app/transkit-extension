/**
 * Granularity Translation Handlers
 * Handles line-by-line and sentence-by-sentence translation modes
 * Uses Mark-and-Map (Delimiter) Strategy with Wrapper-Based Injection
 * AND Inline Grouping + Markdown-First Strategy to preserve structure
 */

/**
 * Check if a node is a Block element that should break the group
 */
function isBlockNode(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tagName = node.tagName.toLowerCase();
  // Known block tags
  return [
      'address', 'article', 'aside', 'blockquote', 'canvas', 'dd', 'div', 'dl', 'dt', 
      'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
      'header', 'hr', 'li', 'main', 'nav', 'noscript', 'ol', 'p', 'pre', 'section', 'table', 
      'tfoot', 'ul', 'video', 'tr', 'td', 'th' // Tables are blocks for our purpose
  ].includes(tagName);
}

/**
 * Get Translation Units (Groups of inline nodes)
 * @param {Element} root - Root element
 * @returns {Array<{nodes: Node[], text: string}>}
 */
function getTranslationUnits(root) {
  const units = [];
  let currentGroup = [];

  function flushGroup() {
    if (currentGroup.length > 0) {
      units.push({ nodes: [...currentGroup] });
      currentGroup = [];
    }
  }

  // Iterate over direct children
  for (let node of root.childNodes) {
      // Skip comments
      if (node.nodeType === Node.COMMENT_NODE) continue;
      
      // Skip our own wrappers
      if (node.nodeType === Node.ELEMENT_NODE && 
         (node.hasAttribute('data-transkit-wrapper') || node.classList.contains('bt-injected-content'))) {
          continue;
      }

      // Skip scripts/styles
      if (node.nodeType === Node.ELEMENT_NODE && ['script', 'style', 'noscript'].includes(node.tagName.toLowerCase())) {
          continue;
      }

      if (isBlockNode(node)) {
          // Block element found: Flush current group
          flushGroup();
          
          // RECURSION: Dive into the block to find units inside it
          // This allows us to translate a whole list (UL) by processing its LIs
          const childUnits = getTranslationUnits(node);
          units.push(...childUnits);
          
      } else {
          // Inline node (Text, Span, A, Code, etc.)
          // Special handling for BR
          if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'br') {
              flushGroup();
          } else {
              currentGroup.push(node);
          }
      }
  }
  flushGroup();
  
  // Filter out empty units (only whitespace)
  return units.filter(unit => {
      const text = unit.nodes.map(n => n.textContent).join('').trim();
      return text.length > 0;
  });
}

/**
 * Convert DOM nodes to Markdown (preserving unknown HTML)
 * @param {Node[]} nodes 
 * @returns {string}
 */
// Markers for escaping < and > in text before sending to API
// Using guillemets « » which are unlikely to appear in code/text
const BRACKET_MARKERS = {
  LT: '«',  // « (U+00AB) - Left-Pointing Double Angle Quotation Mark
  GT: '»',  // » (U+00BB) - Right-Pointing Double Angle Quotation Mark
};

/**
 * Escape < and > in plain text to markers before sending to API
 * This prevents LLM from misinterpreting text like "<0.5%" as HTML tags
 */
function escapeTextBrackets(text) {
  if (!text) return text;
  return text
    .replace(/</g, BRACKET_MARKERS.LT)
    .replace(/>/g, BRACKET_MARKERS.GT);
}

/**
 * Restore markers back to < and > after receiving translation
 * Then escape them as HTML entities for safe rendering
 */
function restoreAndEscapeBrackets(text) {
  if (!text) return text;
  return text
    .replace(new RegExp(BRACKET_MARKERS.LT, 'g'), '&lt;')
    .replace(new RegExp(BRACKET_MARKERS.GT, 'g'), '&gt;');
}

/**
 * Convert DOM nodes to Markdown (preserving unknown HTML)
 * @param {Node[] | NodeList} nodes
 * @returns {string}
 */
function toMarkdown(nodes) {
    let md = '';
    // Handle NodeList or Array
    const nodeList = nodes instanceof NodeList ? Array.from(nodes) : nodes;

    nodeList.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
            // Escape < and > in text to prevent LLM confusion
            md += escapeTextBrackets(node.textContent);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            
            // Handle Void Elements (no children)
            if (['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tag)) {
                md += node.outerHTML;
                return;
            }

            // Process children recursively
            const childMarkdown = toMarkdown(node.childNodes);
            
            switch (tag) {
                case 'b':
                case 'strong':
                    md += `**${childMarkdown}**`;
                    break;
                case 'i':
                case 'em':
                    md += `*${childMarkdown}*`;
                    break;
                case 'code':
                    // For code, we usually want to prevent translation.
                    // Using backticks tells the LLM to ignore it.
                    // We use textContent here because Markdown code blocks don't support internal HTML.
                    // This means we lose syntax highlighting inside inline code, but we protect the code from translation.
                    md += `\`${node.textContent}\``;
                    break;
                case 'a':
                    // Keep link text in brackets to hint it's a link
                    md += `[${childMarkdown}]`;
                    break;
                default:
                    // For unknown inline tags (span, custom), preserve the wrapper but translate the content.
                    // We reconstruct the start and end tags.
                    const clone = node.cloneNode(false); // Clone without children
                    const startTag = clone.outerHTML.replace(/<\/[^>]+>$/, ''); // Remove end tag if present (browsers usually add it for non-void)
                    // Note: outerHTML of a non-void element like <span>foo</span> is <span>foo</span>.
                    // clone.outerHTML of <span> is <span></span>.
                    // We want just <span>.
                    // A safer way:
                    const tagName = node.tagName.toLowerCase();
                    let attrs = '';
                    for (const attr of node.attributes) {
                        attrs += ` ${attr.name}="${attr.value}"`;
                    }
                    const openTag = `<${tagName}${attrs}>`;
                    const closeTag = `</${tagName}>`;
                    
                    md += `${openTag}${childMarkdown}${closeTag}`;
            }
        }
    });
    return md;
}

/**
 * Escape < and > that are NOT part of valid HTML tags
 * This prevents text like "<0.5%" from being parsed as broken HTML
 *
 * Cases to handle:
 * - <0.5%, <100, <$50 (numbers, currency)
 * - <=, >=, <>, <-, ->, << , >> (operators/arrows)
 * - <3 (heart emoticon)
 * - a < b, x > y (math comparisons)
 * - <@user>, <#channel> (mentions)
 * - <<<, >>> (multiple brackets)
 *
 * Valid HTML tags to preserve:
 * - <tagname>, </tagname>, <tagname attr="value">
 * - <br>, <hr>, <img src="..."> (self-closing)
 */
function escapeNonHtmlBrackets(text) {
  if (!text) return text;

  let result = text;

  // Strategy: Replace valid HTML tags with placeholders, escape everything else, restore tags

  // Step 1: Temporarily replace valid HTML tags with placeholders
  const tagPlaceholders = [];
  const tagRegex = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*)?>/g;

  result = result.replace(tagRegex, (match) => {
    const placeholder = `__HTML_TAG_${tagPlaceholders.length}__`;
    tagPlaceholders.push(match);
    return placeholder;
  });

  // Step 2: Escape ALL remaining < and >
  result = result
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Step 3: Restore HTML tags from placeholders
  tagPlaceholders.forEach((tag, index) => {
    result = result.replace(`__HTML_TAG_${index}__`, tag);
  });

  return result;
}

/**
 * Convert Markdown back to HTML
 */
function markupHTML(text) {
  if (!text) return text;

  // Step 1: Restore bracket markers (« ») to HTML entities (&lt; &gt;)
  // This handles text like "(<0.5%)" that was escaped before API call
  let processed = restoreAndEscapeBrackets(text);

  // Step 2: Escape any remaining < or > that aren't part of valid HTML tags
  // This handles cases where API might have introduced new brackets
  processed = escapeNonHtmlBrackets(processed);

  // Step 3: Apply Markdown to HTML conversions
  return processed
    // Bold: **text**
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    // Italic: *text*
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    // Code: `text`
    .replace(/`(.*?)`/g, '<code>$1</code>')
    // Link: [text] -> <span class="bt-link">text</span>
    .replace(/\[(.*?)\]/g, '<span style="text-decoration: underline; cursor: pointer;">$1</span>');
}

/**
 * Handle line-by-line translation (Wrapper-Based + Block-List Grouping + Markdown)
 */
async function handleLineByLineTranslate(
  element, 
  text, 
  settings,
  createPlaceholder,
  updateContent,
  requestTranslation,
  cache,
  clearAllHoverTranslations
) {
  // 1. Check if already translated
  if (element.hasAttribute('data-transkit-translated')) {
    return;
  }

  // 2. Get Translation Units (Groups)
  const units = getTranslationUnits(element);
  
  if (units.length === 0) {
    console.log('[Granularity] No translation units found');
    return;
  }
  
  // 3. Inject Wrappers with Loading Indicators
  const wrappers = [];

  for (const unit of units) {
      const firstNode = unit.nodes[0];
      const parent = firstNode.parentNode;

      if (!parent) continue;

      const wrapper = document.createElement('span');
      wrapper.setAttribute('data-transkit-wrapper', 'true');
      wrapper.style.display = 'inline';

      const originalSpan = document.createElement('span');
      originalSpan.setAttribute('data-transkit-original', 'true');

      const translationSpan = document.createElement('span');
      translationSpan.setAttribute('data-transkit-translation', 'true');
      translationSpan.className = 'bt-loading-indicator';
      // Use inline display with BR separator as requested
      translationSpan.style.display = 'inline';
      // Modern CSS spinner instead of GIF
      translationSpan.innerHTML = '<span class="bt-spinner"></span>';
      
      // Insert wrapper before first node
      parent.insertBefore(wrapper, firstNode);
      
      // Move all nodes into originalSpan
      unit.nodes.forEach(node => {
          originalSpan.appendChild(node);
      });
      
      wrapper.appendChild(originalSpan);
      wrapper.appendChild(document.createElement('br')); // Add line break
      wrapper.appendChild(translationSpan);
      
      wrappers.push({ wrapper, translationSpan });
  }

  // Mark element
  element.setAttribute('data-transkit-translated', 'line');
  element.classList.add('bt-hover-translated');
  
  // 4. Prepare text with Delimiters (Markdown conversion)
  const DELIMITER = ' ||| ';
  const originalMarkdowns = units.map(u => toMarkdown(u.nodes));
  const combinedText = originalMarkdowns.join(DELIMITER);
  
  // Cache key
  const cacheKey = `line-md-${combinedText.length}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;
  
  let translatedSegments;
  if (cache.has(cacheKey)) {
    translatedSegments = cache.get(cacheKey);
  } else {
    try {
      const customPrompt = `Translate the following Markdown text segments. The segments are separated by "${DELIMITER}". Keep the delimiter "${DELIMITER}" in the output at the exact same positions. Preserve Markdown syntax (**, *, \`, []) and HTML tags. Do not translate code inside \`\`. Return the full translated string with delimiters.`;
      
      const res = await requestTranslation({
        text: combinedText,
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: settings.nativeLanguageCode || "vi",
        sourceLanguage: settings.targetLanguageCode || "en",
        useAutoDetect: false,
        customPrompt: customPrompt,
        preserveFormatting: true // segments can contain inline HTML
      });
      
      if (res?.ok && res.result?.translation) {
        const rawTranslation = res.result.translation;
        translatedSegments = rawTranslation.split(/\|\|\|/).map(s => s.trim());
        
        if (translatedSegments.length !== originalMarkdowns.length) {
             console.warn('[Granularity] Delimiter mismatch. Expected:', originalMarkdowns.length, 'Got:', translatedSegments.length);
             if (translatedSegments.length === 1 && rawTranslation.includes('\n')) {
                 translatedSegments = rawTranslation.split('\n').map(s => s.trim());
             }
        }
        
        cache.set(cacheKey, translatedSegments);
      } else {
        console.error('[Granularity] Translation failed:', res?.error);
        wrappers.forEach(({ wrapper, translationSpan }) => {
            translationSpan.textContent = '❌ Error';
        });
        return;
      }
    } catch (err) {
      console.error('[Granularity] Error:', err);
      wrappers.forEach(({ wrapper, translationSpan }) => {
          translationSpan.textContent = '❌ Error';
      });
      return;
    }
  }
  
  // 5. Update Wrappers with Translations
  updateWrappers(wrappers, translatedSegments, settings);
}

async function handleSentenceBySentenceTranslate(
  element,
  text,
  settings,
  createPlaceholder,
  updateContent,
  requestTranslation,
  cache,
  clearAllHoverTranslations
) {
    return handleLineByLineTranslate(
        element, text, settings, createPlaceholder, updateContent, requestTranslation, cache, clearAllHoverTranslations
    );
}

function updateWrappers(wrappers, translations, settings) {
  const textColor = settings.hoverInjectStyle?.textColor || '#ff0000';
  const fontSize = settings.hoverInjectStyle?.fontSize || '0.95em';
  const showIcon = settings.hoverInjectStyle?.showIcon !== false;
  const iconSrc = chrome.runtime.getURL('assets/icons/icon-19.png');
  
  wrappers.forEach(({ wrapper, translationSpan }, i) => {
    if (!translations || i >= translations.length) {
        translationSpan.remove(); 
        return;
    }
    
    const translation = translations[i];
    if (!translation) {
        translationSpan.remove();
        return;
    }

    const markedTranslation = markupHTML(translation);
    
    translationSpan.classList.remove('bt-loading-indicator');
    translationSpan.style.lineHeight = '1.4';
    
    const iconHtml = showIcon 
      ? `<img src="${iconSrc}" class="bt-hover-icon" style="width: 14px; height: 14px; vertical-align: middle; margin-right: 6px; display: inline-block;">` 
      : '';
      
    translationSpan.innerHTML = `${iconHtml}<span style="color: ${textColor}; font-size: ${fontSize};">${markedTranslation}</span>`;
  });
}
