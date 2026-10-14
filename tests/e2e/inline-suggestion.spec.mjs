import { test, expect } from "./fixtures.mjs";

const SUGGESTION = "bt-inline-suggestion";
const SUGGESTION_TEXT = "bt-suggestion-text";

// Content scripts may still be bootstrapping right after load, so retype
// until the suggestion shows up
async function typeUntilSuggestion(page, overlay, text) {
  const field = page.locator("#field");
  await expect(async () => {
    await field.click();
    await field.fill("");
    await page.keyboard.type(text);
    await expect
      .poll(() => overlay.exists(SUGGESTION), { timeout: 3000 })
      .toBe(true);
  }).toPass({ timeout: 15_000 });
}

test.describe("!!lang command", () => {
  test("shows an isolated suggestion naming the provider; Tab applies it", async ({
    page,
    overlay
  }) => {
    await typeUntilSuggestion(page, overlay, "Hello my friend !!vi");

    expect(
      await overlay.computed(SUGGESTION_TEXT, [
        "font-size",
        "color",
        "letter-spacing"
      ])
    ).toEqual({
      "font-size": "14px",
      color: "rgb(31, 41, 55)",
      "letter-spacing": "normal"
    });
    expect(await overlay.text(SUGGESTION_TEXT)).toBe(
      "mock-a:vi:Hello my friend"
    );
    expect(await overlay.text("bt-model-tag")).toBe("Mock A");

    await page.keyboard.press("Tab");
    await expect(page.locator("#field")).toHaveValue(
      "mock-a:vi:Hello my friend"
    );
    await expect.poll(() => overlay.exists(SUGGESTION)).toBe(false);
  });
});

test.describe("Toasts", () => {
  test("instant toggle shortcut shows an isolated toast that goes away", async ({
    page,
    overlay
  }) => {
    await expect(async () => {
      await page.mouse.click(900, 650);
      await page.keyboard.press("ControlOrMeta+Shift+KeyI");
      await expect
        .poll(() => overlay.exists("bt-toast-notify"), { timeout: 1500 })
        .toBe(true);
    }).toPass({ timeout: 10_000 });

    expect(await overlay.text("bt-toast-notify-text")).toContain("127.0.0.1");
    expect(
      await overlay.computed("bt-toast-notify", [
        "font-size",
        "color",
        "position",
        "right",
        "bottom"
      ])
    ).toEqual({
      "font-size": "14px",
      color: "rgb(255, 255, 255)",
      position: "fixed",
      right: "20px",
      bottom: "20px"
    });

    await expect.poll(() => overlay.hostCount(), { timeout: 5000 }).toBe(0);
  });
});

test.describe("Instant mode", () => {
  test.use({
    settings: {
      instantTranslateEnabled: true,
      instantDomains: [{ domain: "127.0.0.1", enabled: true, position: "auto" }]
    }
  });

  test("shows the label and suggests after a pause; clicking the model switcher keeps it", async ({
    page,
    overlay
  }) => {
    await typeUntilSuggestion(page, overlay, "good night");
    expect(await overlay.exists("bt-instant-label")).toBe(true);
    await expect
      .poll(() => overlay.text(SUGGESTION_TEXT))
      .toBe("mock-a:en:good night");

    await overlay.click("bt-suggestion-provider-select");
    await page.waitForTimeout(300);
    expect(await overlay.exists(SUGGESTION)).toBe(true);
  });

  test("switching model re-translates, and Tab applies from the switcher", async ({
    page,
    overlay
  }) => {
    await typeUntilSuggestion(page, overlay, "good night");

    // The state after picking an option: dropdown closed, focus on the
    // switcher. (A mouse click would leave the native dropdown open, which
    // swallows Tab on Linux.)
    await overlay.eval(
      "bt-suggestion-provider-select",
      'this.focus(); this.value = "mock-b"; this.dispatchEvent(new Event("change"));'
    );
    await expect
      .poll(() => overlay.text(SUGGESTION_TEXT))
      .toBe("mock-b:en:good night");

    // Focus is inside the overlay, whose key events are hidden from the page
    await page.keyboard.press("Tab");
    await expect(page.locator("#field")).toHaveValue("mock-b:en:good night");
  });

  test("outside click dismisses the suggestion and removes the overlay", async ({
    page,
    overlay
  }) => {
    await typeUntilSuggestion(page, overlay, "see you");
    await page.mouse.click(900, 650);
    await expect.poll(() => overlay.exists(SUGGESTION)).toBe(false);
    // The instant label fades out after blur, then the empty overlay is removed
    await expect.poll(() => overlay.hostCount(), { timeout: 5000 }).toBe(0);
  });
});
