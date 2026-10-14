import { test, expect, dragSelect, openSelectionPopup } from "./fixtures.mjs";

// Only the result uses this class (the source is a textarea)
const RESULT = "bt-selection-text-content";
const SOURCE = "bt-selection-source-input";

const resultText = (overlay) => overlay.text(RESULT).catch(() => null);

test.describe("Select-to-Translate popup", () => {
  test("is styled by TransKit, not by hostile page CSS", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p1");

    const popup = await overlay.computed("bt-selection-popup", [
      "background-color",
      "font-family",
      "min-width",
      "display"
    ]);
    expect(popup["background-color"]).toBe("rgba(255, 255, 255, 0.95)");
    expect(popup["font-family"]).toContain("system-ui");
    expect(popup["min-width"]).toBe("320px");
    expect(popup.display).toBe("flex");

    // rem is converted to px, so html { font-size: 62.5% } can't shrink text
    const source = await overlay.computed(SOURCE, [
      "font-size",
      "color",
      "letter-spacing"
    ]);
    expect(source).toEqual({
      "font-size": "12px",
      color: "rgb(28, 32, 36)",
      "letter-spacing": "normal"
    });

    // The page tries display:none on the host; it must stay visible
    const box = await overlay.box("bt-selection-popup");
    expect(box.width).toBeGreaterThan(0);
    expect(box.bottom).toBeLessThanOrEqual(750);
  });

  test("translates the selection and shows markup as text", async ({
    page,
    overlay
  }) => {
    const markup = '<img src=x onerror="window.__xss=1"> markup shown as text.';
    await openSelectionPopup(page, overlay, "#p2", { whole: true });

    expect(await overlay.eval(SOURCE, "return this.value")).toBe(markup);
    // Sent as plain text: the markup-looking part must not be stripped
    await expect.poll(() => resultText(overlay)).toBe(`mock-a:vi:${markup}`);
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  });

  test("closes on outside click when not pinned", async ({ page, overlay }) => {
    await openSelectionPopup(page, overlay, "#p1");
    await page.mouse.click(900, 600);
    await expect.poll(() => overlay.exists("bt-selection-popup")).toBe(false);
    expect(await overlay.hostCount()).toBe(0);
  });

  test("pinned popup stays open and auto-loads new selections", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p1");
    await overlay.click("bt-selection-pin");
    expect(
      await overlay.eval(
        "bt-selection-pin",
        'return this.getAttribute("aria-pressed")'
      )
    ).toBe("true");

    await page.mouse.click(900, 600);
    await page.waitForTimeout(300);
    expect(await overlay.exists("bt-selection-popup")).toBe(true);

    // Move it off the paragraphs, then select another one
    const header = await overlay.box("bt-selection-header");
    await page.mouse.move(header.x - 60, header.y);
    await page.mouse.down();
    await page.mouse.move(header.x + 450, header.y + 300, { steps: 8 });
    await page.mouse.up();

    await dragSelect(page, "#p3");
    await expect
      .poll(() => overlay.eval(SOURCE, "return this.value"))
      .toContain("Third paragraph");
    await expect
      .poll(() => resultText(overlay))
      .toMatch(/^mock-a:vi:Third paragraph/);
    expect(await overlay.exists("bt-translate-icon")).toBe(false);

    await overlay.click("bt-selection-close");
    await expect.poll(() => overlay.hostCount()).toBe(0);
  });

  test("source box: debounced typing, Enter, Shift+Enter, keys hidden from page", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p1");
    await overlay.click(SOURCE);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("good morning k");

    await expect
      .poll(() => resultText(overlay))
      .toBe("mock-a:vi:good morning k");
    expect(await page.evaluate(() => window.__keys)).toEqual([]);

    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line2");
    expect(await overlay.eval(SOURCE, "return this.value")).toBe(
      "good morning k\nline2"
    );

    await page.keyboard.press("Enter");
    await expect
      .poll(() => resultText(overlay))
      .toBe("mock-a:vi:good morning k\nline2");
  });

  test("drops a slow stale response in favor of the latest text", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p1");
    await overlay.click(SOURCE);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("first [slow]");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("second");
    await page.keyboard.press("Enter");

    await expect.poll(() => resultText(overlay)).toBe("mock-a:vi:second");
    // Wait past the slow reply; it must not overwrite the newer result
    await page.waitForTimeout(2000);
    expect(await resultText(overlay)).toBe("mock-a:vi:second");
  });

  test("dragging works without clobbering the page's mouse handlers", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p1");
    const before = await overlay.box("bt-selection-popup");
    const header = await overlay.box("bt-selection-header");

    await page.mouse.move(header.x - 60, header.y);
    await page.mouse.down();
    await page.mouse.move(header.x + 140, header.y + 100, { steps: 8 });
    await page.mouse.up();

    const after = await overlay.box("bt-selection-popup");
    expect(Math.round(after.left - before.left)).toBe(200);
    expect(Math.round(after.top - before.top)).toBe(100);
    expect(await page.evaluate(() => typeof document.onmouseup)).toBe(
      "function"
    );
  });

  test("copy button sits beside the text and copies it", async ({
    page,
    overlay
  }) => {
    await openSelectionPopup(page, overlay, "#p4");
    await expect.poll(() => resultText(overlay)).toMatch(/^mock-a:vi:/);

    const text = await overlay.box(RESULT);
    const copy = await overlay.box("bt-selection-copy-btn");
    const overlaps =
      copy.left < text.right &&
      copy.top < text.bottom &&
      copy.bottom > text.top;
    expect(overlaps).toBe(false);

    await overlay.click("bt-selection-copy-btn");
    await expect
      .poll(() =>
        overlay.eval(
          "bt-selection-copy-btn",
          'return this.classList.contains("bt-copied")'
        )
      )
      .toBe(true);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      await resultText(overlay)
    );
  });
});
