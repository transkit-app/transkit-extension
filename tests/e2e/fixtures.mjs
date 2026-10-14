import { test as base, expect, chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_URL } from "./constants.mjs";

const EXTENSION_PATH = fileURLToPath(
  new URL("../../extension", import.meta.url)
);

// Mirrors the defaults in background.js readSettings(), with two mock
// providers pointing at tests/e2e/server.mjs
export function testSettings(overrides = {}) {
  return {
    enabled: true,
    nativeLanguageCode: "vi",
    targetLanguageCode: "en",
    useAutoDetect: false,
    showConfirmModal: true,
    dialogTimeout: 10,
    aliases: { e: "en", v: "vi", ch: "zh", j: "ja" },
    interfaceLanguage: "en",
    instantTranslateEnabled: false,
    instantDelay: 400,
    instantDomains: [],
    activeProviderId: "mock-a",
    providers: [
      {
        id: "mock-a",
        type: "custom",
        name: "Mock A",
        config: { baseUrl: `${BASE_URL}/v1`, model: "mock-a" }
      },
      {
        id: "mock-b",
        type: "custom",
        name: "Mock B",
        config: { baseUrl: `${BASE_URL}/v1`, model: "mock-b" }
      }
    ],
    instantToggleShortcut: { key: "I", ctrl: true, shift: true, alt: false },
    hoverTranslateEnabled: false,
    hoverTranslateMode: "inject",
    hoverTranslateDomains: [],
    hoverModifierKey: "ctrl",
    hoverToggleShortcut: { key: "O", ctrl: true, shift: true, alt: false },
    hoverInjectStyle: {
      backgroundColor: "#667eea",
      textColor: "#0c69e4",
      fontSize: "0.95em",
      showIcon: true,
      underline: false
    },
    selectionLastSource: null,
    selectionLastTarget: null,
    ...overrides
  };
}

// Reads TransKit's UI, which lives in a closed shadow root that page scripts
// and Playwright locators cannot reach. CDP DOM queries with pierce: true can.
export class Overlay {
  constructor(page, cdp) {
    this.page = page;
    this.cdp = cdp;
  }

  static async attach(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    return new Overlay(page, cdp);
  }

  // First node (in document order, shadow roots included) whose class list
  // contains every class in `selector` ("a.b" or "a")
  async find(selector) {
    const classes = selector.split(".").filter(Boolean);
    const { root } = await this.cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true
    });
    let hit = null;
    const walk = (node) => {
      if (hit) return;
      const attrs = node.attributes || [];
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === "class") {
          const list = attrs[i + 1].split(/\s+/);
          if (classes.every((c) => list.includes(c))) {
            hit = node;
            return;
          }
        }
      }
      for (const child of [
        ...(node.children || []),
        ...(node.shadowRoots || [])
      ]) {
        walk(child);
      }
    };
    walk(root);
    return hit;
  }

  async exists(selector) {
    return (await this.find(selector)) !== null;
  }

  async box(selector) {
    const node = await this.find(selector);
    if (!node) throw new Error(`Overlay element not found: ${selector}`);
    const { model } = await this.cdp.send("DOM.getBoxModel", {
      nodeId: node.nodeId
    });
    const [left, top, right, , , bottom] = model.border;
    return {
      left,
      top,
      right,
      bottom,
      width: model.width,
      height: model.height,
      x: (left + right) / 2,
      y: (top + bottom) / 2
    };
  }

  async computed(selector, props) {
    const node = await this.find(selector);
    if (!node) throw new Error(`Overlay element not found: ${selector}`);
    const { computedStyle } = await this.cdp.send(
      "CSS.getComputedStyleForNode",
      {
        nodeId: node.nodeId
      }
    );
    return Object.fromEntries(
      computedStyle
        .filter((p) => props.includes(p.name))
        .map((p) => [p.name, p.value])
    );
  }

  // Runs `body` with `this` bound to the element, e.g. "return this.value"
  async eval(selector, body) {
    const node = await this.find(selector);
    if (!node) throw new Error(`Overlay element not found: ${selector}`);
    const { object } = await this.cdp.send("DOM.resolveNode", {
      nodeId: node.nodeId
    });
    const { result, exceptionDetails } = await this.cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId: object.objectId,
        functionDeclaration: `function () { ${body} }`,
        returnByValue: true
      }
    );
    if (exceptionDetails)
      throw new Error(exceptionDetails.exception?.description);
    return result.value;
  }

  async click(selector) {
    const { x, y } = await this.box(selector);
    await this.page.mouse.click(x, y);
  }

  async text(selector) {
    return this.eval(selector, "return this.textContent.trim()");
  }

  async hostCount() {
    return this.page.evaluate(
      () => document.querySelectorAll("transkit-overlay").length
    );
  }
}

export const test = base.extend({
  // Per-test settings overrides: test.use({ settings: { ... } })
  settings: [{}, { option: true }],

  context: async ({}, use) => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "transkit-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // The full Chromium build: the headless shell cannot load extensions
      channel: "chromium",
      headless: true,
      viewport: { width: 1100, height: 750 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`
      ]
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: BASE_URL
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    await use(worker);
  },

  // Settings are seeded before the page loads so content scripts read them
  page: async ({ context, serviceWorker, settings }, use) => {
    await serviceWorker.evaluate(async (value) => {
      await chrome.storage.local.set({ translatorSettings: value });
    }, testSettings(settings));
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/hostile.html`);
    await use(page);
  },

  overlay: async ({ page }, use) => {
    await use(await Overlay.attach(page));
  }
});

export { expect };

export async function readStoredSettings(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { translatorSettings } =
      await chrome.storage.local.get("translatorSettings");
    return translatorSettings;
  });
}

// Drag-selects text inside a page element, like a user would
export async function dragSelect(page, selector, { width = 300 } = {}) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + Math.min(box.height / 2, 12);
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(width, box.width - 2), y, {
    steps: 5
  });
  await page.mouse.up();
}

// Selects text and opens the popup through the icon. Retries the selection
// because content scripts may still be bootstrapping right after page load.
export async function openSelectionPopup(page, overlay, selector) {
  await expect(async () => {
    await page.mouse.click(1000, 700);
    await dragSelect(page, selector);
    await expect
      .poll(() => overlay.exists("bt-translate-icon"), { timeout: 1500 })
      .toBe(true);
  }).toPass({ timeout: 10_000 });
  await overlay.click("bt-translate-icon");
  await expect.poll(() => overlay.exists("bt-selection-popup")).toBe(true);

  // The popup widens when the translation arrives and re-positions itself
  // (at 100 ms and 500 ms), so wait for it to settle before clicking inside
  await expect
    .poll(() =>
      overlay.eval(
        "bt-selection-text-content",
        'return !this.classList.contains("bt-loading-text")'
      )
    )
    .toBe(true);
  await waitForStableBox(overlay, "bt-selection-popup");
}

// Resolves once an element's position and size stop changing
export async function waitForStableBox(overlay, selector) {
  let previous = null;
  await expect
    .poll(
      async () => {
        const { left, top, width, height } = await overlay.box(selector);
        const current = JSON.stringify({ left, top, width, height });
        const stable = current === previous;
        previous = current;
        return stable;
      },
      { intervals: [150], timeout: 5000 }
    )
    .toBe(true);
}
