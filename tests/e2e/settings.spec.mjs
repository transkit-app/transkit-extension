import {
  test,
  expect,
  openSelectionPopup,
  readStoredSettings
} from "./fixtures.mjs";

test("popup language choices are saved without reverting other settings", async ({
  page,
  overlay,
  serviceWorker
}) => {
  await openSelectionPopup(page, overlay, "#p1");

  // Another part of the extension changes a setting while the popup is open
  await serviceWorker.evaluate(async () => {
    const { translatorSettings } =
      await chrome.storage.local.get("translatorSettings");
    await chrome.storage.local.set({
      translatorSettings: { ...translatorSettings, nativeLanguageCode: "ja" }
    });
  });

  const choose = (select, value) =>
    overlay.eval(
      select,
      `this.value = ${JSON.stringify(value)}; this.dispatchEvent(new Event("change"));`
    );
  await choose("bt-selection-target-select", "fr");
  await choose("bt-selection-source-select", "en");

  await expect
    .poll(() => readStoredSettings(serviceWorker))
    .toMatchObject({
      selectionLastTarget: "fr",
      selectionLastSource: "en",
      nativeLanguageCode: "ja"
    });
});
