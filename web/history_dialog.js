import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createViewerBridge } from "./lib/viewerBridge.js";
import { createPreviewNotifier, extractEntryIds } from "./lib/previewNotifier.js";
import {
  getPreviewSettingsStore,
  DEFAULT_SETTINGS,
  MIN_VIEWPORT_PERCENT,
  MAX_VIEWPORT_PERCENT,
} from "./lib/previewSettings.js";
import {
  clamp,
  createEl,
  ensureStylesheet,
  formatTimestamp,
  logError,
  logInfo,
} from "./lib/dom.js";
import {
  applyPromptToWidget,
  normalizeTargetPayload,
  resolveComfyApi,
  resolveComfyApp,
  resolveNodeFromTarget,
  resolvePromptWidget,
  resolveUpstreamConnection,
  findFirstFreeStringWidget,
} from "./lib/comfyBridge.js";

export {};
const EXTENSION_NAME = "PromptHistoryGallery.NodeDialog";
const HISTORY_UPDATE_EVENT = "PromptHistoryGallery.updated";
const HISTORY_LIMIT_MIN = 20;
const HISTORY_LIMIT_MAX = 1000;
const HISTORY_WIDGET_FLAG = "__phg_history_widget__";
const HISTORY_WIDGET_LABEL = "⏱ History";

const TEXT = {
  title: "Prompt History",
  subtitleMissing: "No active Prompt History Input — prompts will be copied.",
  subtitleTarget: (name) => `Sending to: ${name ?? "Prompt History Input"}`,
  loading: "Loading history…",
  empty: "No prompt history yet. Run a workflow to populate this list.",
  copied: "Prompt copied to clipboard.",
  copiedFallback: "Prompt copied (no active node).",
  copiedMissingWidget: "Prompt widget missing on node. Copied instead.",
  copiedMissingNode: "Target node was removed. Prompt copied instead.",
  sent: (name) => `Prompt sent to ${name ?? "node"}.`,
  same: "Prompt already matches the node input.",
  noImages: "No images available for this prompt.",
  deleteConfirm: "Delete this prompt history entry?",
  deleteSuccess: "History entry deleted.",
  deleteError: "Failed to delete entry.",
  saveSuccess: "File saved successfully.",
  saveError: "Failed to save file.",
  settingsTitle: "Settings",
  settingsHint: "Configure extension behavior.",
  settingsReset: "Reset to defaults",
  settingsClose: "Close",
  tabHistory: "History",
  tabSettings: "Settings",
  sectionGeneral: "General",
  sectionUsage: "List Appearance",
  sectionPreview: "Popup Preview",
  sectionArchive: "Archive Settings",
  historyLimitLabel: "History Limit",
  historyLimitHint: "Number of prompts to keep in history.",
  searchPlaceholder: "Search prompts…",
  searchModeAnd: "Match all terms (AND)",
  searchModeOr: "Match any term (OR)",
  searchClear: "Clear",
  searchNoResults: "No prompts match your search.",
  usageSettingsHighlight: "Highlight Frequent Prompts",
  usageSettingsRatio: "Highlight Threshold (% of max)",
  usageSettingsStart: "Minimum Images to Highlight",
  previewToggle: "Enable Popup Preview",
  previewDuration: "Popup Duration",
  previewSizeLandscape: "Landscape Size (% width)",
  previewSizePortrait: "Portrait Size (% height)",
  archiveToggle: "Enable Image Archiving",
  archiveFolderLabel: "Archive Folder Name",
  archiveFolderHint: "Folder name for archived images (relative to ComfyUI output directory)",
  archivePromptsToggle: "Save Prompts as Text Files",
  archivePromptsHint: "Save positive and negative prompts to .txt files alongside archived images",
};

const USAGE_RATIO_MIN = 0.05;
const USAGE_RATIO_MAX = 1;
const USAGE_START_MIN = 1;
const USAGE_START_MAX = 100;

const PREVIEW_MIN_MS = 1000;
const PREVIEW_MAX_MS = 15000;
const PREVIEW_STEP_MS = 250;
const PREVIEW_MIN_PERCENT = MIN_VIEWPORT_PERCENT;
const PREVIEW_MAX_PERCENT = MAX_VIEWPORT_PERCENT;
const LOGGER = console;

class HistoryDialog {
  constructor({ api, comfyApp }) {
    ensureStylesheet();
    this.api = api ?? resolveComfyApi();
    this.comfyApp = comfyApp ?? resolveComfyApp();
    this.historyApi = createHistoryApi(this.api);
    this.viewer = createViewerBridge({
      cssUrl: new URL("./vendor/viewerjs/viewer.min.css", import.meta.url).href,
      scriptUrl: new URL("./vendor/viewerjs/viewer.min.js", import.meta.url).href,
    });
    this.settingsStore = getPreviewSettingsStore();
    this.settingsState = this.settingsStore?.getState?.() ?? DEFAULT_SETTINGS;
    this.unsubscribeSettings =
      this.settingsStore?.subscribe?.((next) => {
        const previous = this.settingsState;
        this.settingsState = next ?? this.settingsState;
        this._syncSettingsUI();
        if (
          previous?.highlightUsage !== this.settingsState?.highlightUsage ||
          previous?.highlightUsageRatio !== this.settingsState?.highlightUsageRatio
        ) {
          this._renderEntries();
        }
        if (previous?.historyLimit !== this.settingsState?.historyLimit && this.state?.isOpen) {
          this.refresh();
        }
      }) ?? null;

    this._comfyShortcutGuard = null;

    this.state = {
      isOpen: false,
      loading: false,
      error: "",
      entries: [],
      target: null,
      activeTab: "history",
      searchQuery: "",
      searchMode: "and",
    };

    this.messageTimeout = null;
    this._buildLayout();
    this._updateTargetLabel();
    this._switchTab("history"); // Default tab
    
    // Initial sync: fetch archive settings from server first, then apply to UI
    this._initArchiveSettings();
  }
  
  async _initArchiveSettings() {
    // First, sync current UI/localStorage settings to server (silent, no UI updates)
    // This ensures server gets the user's saved preferences on startup
    await this._syncArchiveSettingsToServerSilent();
    
    // Then fetch settings from server to confirm they were applied
    // This also handles the case where server might have different settings
    await this._syncArchiveSettingsFromServer();
    
    // Finally, update UI with the confirmed settings
    this._syncSettingsUI();
  }

  openWithNode(node) {
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();
    this.open();
  }

  open() {
    if (this.state.isOpen) {
      this.refresh();
      return;
    }
    this.state.isOpen = true;
    this._installComfyShortcutGuard();
    this.backdrop.classList.remove("phg-hidden");
    this.refresh();
  }

  close() {
    if (!this.state.isOpen) return;
    this.state.isOpen = false;
    this._removeComfyShortcutGuard();
    this.backdrop.classList.add("phg-hidden");
    this.viewer.close();
  }

  isOpen() {
    return this.state.isOpen;
  }

  async refresh() {
    this._setLoading(true);
    this._setMessage(TEXT.loading, "muted");
    try {
      const items = await this.historyApi.list(this._getHistoryLimit());
      this.state.entries = items;
      this.state.error = "";
      this._setMessage("");
    } catch (error) {
      logError(LOGGER, "refresh error", error);
      this.state.error = error?.message ?? "Failed to load prompt history.";
      this._setMessage(this.state.error, "error");
    } finally {
      this._setLoading(false);
      this._renderEntries();
    }
  }

  refreshIfOpen() {
    if (this.state.isOpen) {
      this.refresh();
    }
  }

  _getHistoryLimit() {
    const settingValue = this.settingsState?.historyLimit ?? DEFAULT_SETTINGS.historyLimit;
    return clamp(
      Number(settingValue) || DEFAULT_SETTINGS.historyLimit,
      HISTORY_LIMIT_MIN,
      HISTORY_LIMIT_MAX
    );
  }

  _switchTab(tabId) {
    this.state.activeTab = tabId;

    // Update Tab Buttons
    [this.historyTabBtn, this.settingsTabBtn].forEach((btn) => {
      if (btn) btn.dataset.active = btn.dataset.tab === tabId ? "true" : "false";
    });

    // Update Views
    if (this.historyView && this.settingsView) {
      if (tabId === "history") {
        this.historyView.classList.remove("phg-hidden");
        this.settingsView.classList.add("phg-hidden");
      } else {
        this.historyView.classList.add("phg-hidden");
        this.settingsView.classList.remove("phg-hidden");
      }
    }
  }

  _formatDuration(ms) {
    const safeValue = clamp(
      Number(ms) || DEFAULT_SETTINGS.displayDuration,
      PREVIEW_MIN_MS,
      PREVIEW_MAX_MS
    );
    return `${safeValue}ms`;
  }

  _resetSettings() {
    if (!this.settingsStore?.reset) return;
    this.settingsStore.reset();
    this.settingsState = this.settingsStore.getState?.() ?? DEFAULT_SETTINGS;
    this._syncSettingsUI();
  }

  _applySettingsPatch(patch) {
    if (!patch || typeof patch !== "object") return;
    this.settingsStore?.update?.(patch);
    this.settingsState = this.settingsStore?.getState?.() ?? this.settingsState;
    this._syncSettingsUI();
    
    // Sync archive settings to server when they change
    if (
      patch.archiveEnabled !== undefined ||
      patch.archiveFolderName !== undefined ||
      patch.archivePromptsEnabled !== undefined
    ) {
      this._syncArchiveSettingsToServer();
    }
  }
  
  async _syncArchiveSettingsToServer() {
    try {
      const payload = {
        enabled: this.settingsState?.archiveEnabled ?? false,
        folder_name: this.settingsState?.archiveFolderName ?? "archive",
        prompts_enabled: this.settingsState?.archivePromptsEnabled ?? false,
      };
      
      const response = await this.api.fetchApi("/prompt-history-gallery/archive-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        console.error("[PHG] Failed to sync archive settings to server");
      } else {
        console.log("[PHG] Archive settings synced to server:", payload);
      }
    } catch (error) {
      console.error("[PHG] Error syncing archive settings:", error);
    }
  }
  
  /**
   * Sync archive settings to server without triggering UI updates.
   * Used during initialization to avoid infinite loops.
   */
  async _syncArchiveSettingsToServerSilent() {
    try {
      const payload = {
        enabled: this.settingsState?.archiveEnabled ?? false,
        folder_name: this.settingsState?.archiveFolderName ?? "archive",
        prompts_enabled: this.settingsState?.archivePromptsEnabled ?? false,
      };
      
      const response = await this.api.fetchApi("/prompt-history-gallery/archive-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      
      if (!response.ok) {
        console.error("[PHG] Failed to sync archive settings to server");
      } else {
        console.log("[PHG] Archive settings synced to server (silent):", payload);
      }
    } catch (error) {
      console.error("[PHG] Error syncing archive settings:", error);
    }
  }
  
  async _syncArchiveSettingsFromServer() {
    try {
      const response = await this.api.fetchApi("/prompt-history-gallery/archive-settings");
      
      if (!response.ok) {
        console.error("[PHG] Failed to fetch archive settings from server");
        return;
      }
      
      const data = await response.json();
      if (data.success && data.settings) {
        const serverSettings = data.settings;
        
        // Update local settings state with server values
        const patch = {};
        if (typeof serverSettings.enabled === "boolean") {
          patch.archiveEnabled = serverSettings.enabled;
        }
        if (typeof serverSettings.folder_name === "string" && serverSettings.folder_name.trim()) {
          patch.archiveFolderName = serverSettings.folder_name.trim();
        }
        if (typeof serverSettings.prompts_enabled === "boolean") {
          patch.archivePromptsEnabled = serverSettings.prompts_enabled;
        }
        
        // Only apply patch if there are actual changes to avoid unnecessary updates
        if (Object.keys(patch).length > 0) {
          // Directly update the settings store without triggering another sync
          // This prevents infinite loops during initialization
          this.settingsStore?.update?.(patch);
          this.settingsState = this.settingsStore?.getState?.() ?? this.settingsState;
          console.log("[PHG] Archive settings loaded from server:", serverSettings);
        }
      }
    } catch (error) {
      console.error("[PHG] Error fetching archive settings from server:", error);
    }
  }
  
  async _createArchiveFolder(folderName) {
    const messageEl = this.archiveFolderMessage;
    if (!messageEl) return;
    
    // Clear previous message
    messageEl.classList.remove("phg-field-message--success", "phg-field-message--error");
    messageEl.classList.add("phg-field-message--hidden");
    messageEl.textContent = "";
    
    const safeFolderName = (folderName || "archive").trim();
    if (!safeFolderName) {
      messageEl.textContent = "Please enter a valid folder name";
      messageEl.classList.remove("phg-field-message--hidden");
      messageEl.classList.add("phg-field-message--error");
      return;
    }
    
    try {
      const response = await this.api.fetchApi("/prompt-history-gallery/create-archive-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_name: safeFolderName }),
      });
      
      // Read response text to check for "already exists" message
      const responseText = await response.text();
      
      // Handle response based on HTTP status and content
      // Status 200 = folder created successfully
      // Status 409 = folder already exists
      if (response.status === 409) {
        messageEl.textContent = `✓ Folder '${safeFolderName}' already exists`;
        messageEl.classList.remove("phg-field-message--hidden");
        messageEl.classList.add("phg-field-message--success");
      } else if (response.ok) {
        messageEl.textContent = `✓ Folder '${safeFolderName}' created successfully`;
        messageEl.classList.remove("phg-field-message--hidden");
        messageEl.classList.add("phg-field-message--success");
        // Also sync settings to ensure server knows about this folder
        await this._syncArchiveSettingsToServer();
      } else {
        messageEl.textContent = `✗ Failed to create folder: ${response.status} ${response.statusText}`;
        messageEl.classList.remove("phg-field-message--hidden");
        messageEl.classList.add("phg-field-message--error");
      }
    } catch (error) {
      console.error("[PHG] Error creating archive folder:", error);
      messageEl.textContent = `✗ Error: ${error.message || "Failed to create folder"}`;
      messageEl.classList.remove("phg-field-message--hidden");
      messageEl.classList.add("phg-field-message--error");
    }
  }

  _buildSettingsView() {
    const container = createEl("div", "phg-settings-container phg-hidden");

    // -- List Appearance --
    const listGroup = this._buildSettingsGroup(TEXT.sectionUsage, [
      this._buildHistoryLimitField(),
      this._buildToggleField(
        TEXT.usageSettingsHighlight,
        () => this.settingsState?.highlightUsage !== false,
        (checked) => this._applySettingsPatch({ highlightUsage: checked }),
        "highlightToggleInput"
      ),
      this._buildNumberField(
        TEXT.usageSettingsStart,
        () =>
          this.settingsState?.highlightUsageStartCount ?? DEFAULT_SETTINGS.highlightUsageStartCount,
        (val) => this._applySettingsPatch({ highlightUsageStartCount: val }),
        USAGE_START_MIN,
        USAGE_START_MAX,
        1,
        (v) => `${v} images`,
        "highlightStartInput"
      ),
      this._buildNumberField(
        TEXT.usageSettingsRatio,
        () =>
          Math.round(
            (this.settingsState?.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio) * 100
          ),
        (val) => this._applySettingsPatch({ highlightUsageRatio: val / 100 }),
        Math.round(USAGE_RATIO_MIN * 100),
        100,
        5,
        (v) => `${v}%`,
        "highlightRatioInput"
      ),
    ]);

    // -- Preview Popup --
    const previewContainer = createEl("div", "phg-settings-group");

    // Header with Toggle
    const previewHeader = createEl(
      "div",
      "phg-settings-group__header phg-settings-group__header--row"
    );

    const previewTitle = createEl("div", "phg-settings-group__title", TEXT.sectionPreview);

    // Wrapper for the toggle to sit in the header
    const toggleControl = createEl("div", "phg-settings-control");
    const toggleLabel = createEl("label", "phg-toggle");
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = this.settingsState?.enabled !== false;

    const toggleSlider = createEl("span", "phg-toggle-slider");
    toggleLabel.append(toggleInput, toggleSlider);
    toggleControl.append(toggleLabel);

    previewHeader.append(previewTitle, toggleControl);

    // Collapsible Content
    const previewContent = createEl("div", "phg-settings-group__content");
    if (!toggleInput.checked) {
      previewContent.style.display = "none";
    }

    // Toggle Logic
    toggleInput.addEventListener("change", () => {
      const checked = toggleInput.checked;
      this._applySettingsPatch({ enabled: checked });
      previewContent.style.display = checked ? "block" : "none";
    });
    this.previewToggleInput = toggleInput; // Bind for sync

    // Add items to content
    previewContent.append(
      this._buildNumberField(
        TEXT.previewDuration,
        () => this.settingsState?.displayDuration ?? DEFAULT_SETTINGS.displayDuration,
        (val) => this._applySettingsPatch({ displayDuration: val }),
        PREVIEW_MIN_MS,
        PREVIEW_MAX_MS,
        PREVIEW_STEP_MS,
        (v) => this._formatDuration(v),
        "durationInput"
      ),
      this._buildNumberField(
        TEXT.previewSizeLandscape,
        () =>
          this.settingsState?.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent,
        (val) => this._applySettingsPatch({ landscapeViewportPercent: val }),
        PREVIEW_MIN_PERCENT,
        PREVIEW_MAX_PERCENT,
        1,
        (v) => `${v}%`,
        "landscapeInput"
      ),
      this._buildNumberField(
        TEXT.previewSizePortrait,
        () =>
          this.settingsState?.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent,
        (val) => this._applySettingsPatch({ portraitViewportPercent: val }),
        PREVIEW_MIN_PERCENT,
        PREVIEW_MAX_PERCENT,
        1,
        (v) => `${v}%`,
        "portraitInput"
      )
    );

    previewContainer.append(previewHeader, previewContent);
    const previewGroup = previewContainer;

    // -- Archive Settings --
    const archiveGroup = this._buildSettingsGroup(TEXT.sectionArchive, [
      this._buildToggleField(
        TEXT.archiveToggle,
        () => this.settingsState?.archiveEnabled !== false,
        (checked) => this._applySettingsPatch({ archiveEnabled: checked }),
        "archiveToggleInput"
      ),
      this._buildTextField(
        TEXT.archiveFolderLabel,
        TEXT.archiveFolderHint,
        () => this.settingsState?.archiveFolderName ?? DEFAULT_SETTINGS.archiveFolderName,
        (val) => this._applySettingsPatch({ archiveFolderName: val }),
        "archiveFolderInput",
        {
          label: "Create Folder",
          title: "Create archive folder in output directory",
          messageRef: "archiveFolderMessage",
          onClick: (folderName) => this._createArchiveFolder(folderName),
        },
        /* disabledWhen */ () => !(this.settingsState?.archiveEnabled !== false)
      ),
      this._buildToggleField(
        TEXT.archivePromptsToggle,
        () => this.settingsState?.archivePromptsEnabled !== false,
        (checked) => this._applySettingsPatch({ archivePromptsEnabled: checked }),
        "archivePromptsToggleInput",
        /* disabledWhen */ () => !(this.settingsState?.archiveEnabled !== false)
      ),
    ]);

    const footer = createEl("div", "phg-settings-footer");
    const resetBtn = this._createButton(
      TEXT.settingsReset,
      "Restore defaults",
      () => this._resetSettings(),
      "ghost"
    );
    footer.append(resetBtn);

    container.append(listGroup, previewGroup, archiveGroup, footer);
    return container;
  }

  _buildSettingsGroup(title, items) {
    const group = createEl("div", "phg-settings-group");
    const header = createEl("div", "phg-settings-group__header");
    const titleEl = createEl("div", "phg-settings-group__title", title);
    header.append(titleEl);
    group.append(header, ...items);
    return group;
  }

  _buildToggleField(label, getValue, onChange, refName, disabledWhen) {
    const item = createEl("div", "phg-settings-item");
    const info = createEl("div", "phg-settings-item__info");
    info.append(createEl("div", "phg-settings-item__label", label));

    const control = createEl("div", "phg-settings-control");
    const toggle = createEl("label", "phg-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = getValue();
    
    const isDisabled = disabledWhen ? disabledWhen() : false;
    input.disabled = isDisabled;
    if (isDisabled) {
      toggle.classList.add("phg-toggle--disabled");
    }
    
    // Store reference to update disabled state dynamically
    const toggleLabelEl = toggle;
    input.addEventListener("change", () => {
      onChange(input.checked);
      // Re-evaluate disabled state on change
      if (disabledWhen) {
        const shouldBeDisabled = disabledWhen();
        input.disabled = shouldBeDisabled;
        if (shouldBeDisabled) {
          toggleLabelEl.classList.add("phg-toggle--disabled");
        } else {
          toggleLabelEl.classList.remove("phg-toggle--disabled");
        }
      }
    });

    const slider = createEl("span", "phg-toggle-slider");
    toggle.append(input, slider);
    control.append(toggle);

    item.append(info, control);

    if (refName) this[refName] = input;
    return item;
  }

  _buildTextField(label, hint, getValue, onChange, refName, addButton, disabledWhen) {
    const item = createEl("div", "phg-settings-item phg-settings-item--col");

    const headerObj = createEl("div", "phg-settings-item__header");
    const labelEl = createEl("div", "phg-settings-item__label", label);
    headerObj.append(labelEl);

    const control = createEl("div", "phg-range-wrapper");
    const inputWrapper = createEl("div", "phg-input-wrapper");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "phg-text-input";
    input.value = getValue();
    input.placeholder = hint;
    
    const isDisabled = disabledWhen ? disabledWhen() : false;
    input.disabled = isDisabled;

    // Only update on change (blur/enter), not on every input character
    // This prevents creating folders on every keystroke when a button is present
    if (addButton) {
      input.addEventListener("change", () => {
        if (!isDisabled) onChange(input.value.trim());
      });
    } else {
      input.addEventListener("input", () => {
        if (!isDisabled) onChange(input.value);
      });
      input.addEventListener("change", () => {
        if (!isDisabled) onChange(input.value.trim());
      });
    }

    inputWrapper.append(input);
    
    // Add optional button (e.g., "Create Folder")
    if (addButton) {
      const btn = document.createElement("button");
      btn.className = "phg-create-folder-btn";
      btn.textContent = addButton.label;
      btn.title = addButton.title || "";
      btn.disabled = isDisabled;
      btn.addEventListener("click", () => {
        if (!isDisabled) addButton.onClick(input.value.trim());
      });
      inputWrapper.append(btn);
    }

    control.append(inputWrapper);
    item.append(headerObj, control);

    // Message area for feedback
    const messageEl = createEl("div", "phg-field-message phg-field-message--hidden");
    item.append(messageEl);

    if (refName) this[refName] = input;
    if (addButton && addButton.messageRef) this[addButton.messageRef] = messageEl;
    
    return item;
  }

  _buildNumberField(label, getValue, onChange, min, max, step, formatDisplay, refName) {
    const item = createEl("div", "phg-settings-item phg-settings-item--col");

    const headerObj = createEl("div", "phg-settings-item__header");

    const labelEl = createEl("div", "phg-settings-item__label", label);
    const valueEl = createEl("div", "phg-range-value");
    const currentVal = getValue();
    valueEl.textContent = formatDisplay(currentVal);

    headerObj.append(labelEl, valueEl);

    const control = createEl("div", "phg-range-wrapper");
    const range = document.createElement("input");
    range.type = "range";
    range.className = "phg-range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(currentVal);

    range.addEventListener("input", () => {
      const val = Number(range.value);
      valueEl.textContent = formatDisplay(val);
    });
    range.addEventListener("change", () => {
      onChange(Number(range.value));
    });

    control.append(range);
    item.append(headerObj, control);

    if (refName) this[refName] = range;
    // We can also store the value label to update it if state changes externally
    if (refName) this[refName + "Display"] = valueEl;

    return item;
  }
  _buildHistoryLimitField() {
    const getValue = () => this._getHistoryLimit();
    const item = createEl("div", "phg-settings-item phg-settings-item--col");

    const headerObj = createEl("div", "phg-settings-item__header");
    headerObj.append(
      createEl("div", "phg-settings-item__label", TEXT.historyLimitLabel),
      createEl("div", "phg-range-value", `${getValue()} items`)
    );
    this.historyLimitValue = headerObj.lastChild;

    const control = createEl("div", "phg-range-wrapper");
    const range = document.createElement("input");
    range.type = "range";
    range.className = "phg-range";
    range.min = String(HISTORY_LIMIT_MIN);
    range.max = String(HISTORY_LIMIT_MAX);
    range.step = "10";
    range.value = String(getValue());

    range.addEventListener("input", () => {
      this.historyLimitValue.textContent = `${range.value} items`;
    });
    range.addEventListener("change", () => {
      const next = clamp(
        Number(range.value) || DEFAULT_SETTINGS.historyLimit,
        HISTORY_LIMIT_MIN,
        HISTORY_LIMIT_MAX
      );
      this._applySettingsPatch({ historyLimit: next });
    });

    control.append(range);
    item.append(headerObj, control);
    this.historyLimitRange = range;
    return item;
  }

  _syncSettingsUI() {
    const state = this.settingsStore?.getState?.() ?? this.settingsState ?? DEFAULT_SETTINGS;
    this.settingsState = state;

    // History Limit
    if (this.historyLimitRange) {
      const limit = this._getHistoryLimit();
      this.historyLimitRange.value = String(limit);
      if (this.historyLimitValue) this.historyLimitValue.textContent = `${limit} items`;
    }

    // Toggle: Highlight Usage
    if (this.highlightToggleInput) {
      this.highlightToggleInput.checked = state.highlightUsage !== false;
    }

    // Number: Highlight Start
    if (this.highlightStartInput) {
      const start = clamp(
        Number(state.highlightUsageStartCount ?? DEFAULT_SETTINGS.highlightUsageStartCount),
        USAGE_START_MIN,
        USAGE_START_MAX
      );
      this.highlightStartInput.value = String(start);
      if (this.highlightStartInputDisplay) {
        this.highlightStartInputDisplay.textContent = `${start} images`;
      }
      this.highlightStartInput.disabled = state.highlightUsage === false;
    }

    // Number: Ratio
    if (this.highlightRatioInput) {
      const ratioValue = clamp(
        Number(state.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio),
        USAGE_RATIO_MIN,
        USAGE_RATIO_MAX
      );
      const percent = Math.round(ratioValue * 100);
      this.highlightRatioInput.value = String(percent);
      if (this.highlightRatioInputDisplay) {
        this.highlightRatioInputDisplay.textContent = `${percent}%`;
      }
      this.highlightRatioInput.disabled = state.highlightUsage === false;
    }

    // Toggle: Preview
    if (this.previewToggleInput) {
      const isEnabled = state.enabled !== false;
      this.previewToggleInput.checked = isEnabled;
      // Update content visibility
      const toggleLabel = this.previewToggleInput.closest(".phg-settings-control");
      const header = toggleLabel?.parentNode;
      const content = header?.nextElementSibling;
      if (content && content.classList.contains("phg-settings-group__content")) {
        content.style.display = isEnabled ? "block" : "none";
      }
    }

    // Number: Duration
    if (this.durationInput) {
      const val = clamp(
        Number(state.displayDuration ?? DEFAULT_SETTINGS.displayDuration),
        PREVIEW_MIN_MS,
        PREVIEW_MAX_MS
      );
      this.durationInput.value = String(val);
      if (this.durationInputDisplay) {
        this.durationInputDisplay.textContent = this._formatDuration(val);
      }
    }

    // Number: Landscape
    if (this.landscapeInput) {
      const val = clamp(
        Number(state.landscapeViewportPercent ?? DEFAULT_SETTINGS.landscapeViewportPercent),
        PREVIEW_MIN_PERCENT,
        PREVIEW_MAX_PERCENT
      );
      this.landscapeInput.value = String(val);
      if (this.landscapeInputDisplay) this.landscapeInputDisplay.textContent = `${val}%`;
    }

    // Number: Portrait
    if (this.portraitInput) {
      const val = clamp(
        Number(state.portraitViewportPercent ?? DEFAULT_SETTINGS.portraitViewportPercent),
        PREVIEW_MIN_PERCENT,
        PREVIEW_MAX_PERCENT
      );
      this.portraitInput.value = String(val);
      if (this.portraitInputDisplay) this.portraitInputDisplay.textContent = `${val}%`;
    }

    // Toggle: Archive
    if (this.archiveToggleInput) {
      this.archiveToggleInput.checked = state.archiveEnabled !== false;
    }

    // Text: Archive Folder Name
    if (this.archiveFolderInput) {
      this.archiveFolderInput.value = state.archiveFolderName ?? DEFAULT_SETTINGS.archiveFolderName;
      // Also disable folder input and button when archive is disabled
      const isArchiveDisabled = !(state.archiveEnabled !== false);
      this.archiveFolderInput.disabled = isArchiveDisabled;
      // Also disable the create folder button
      const inputWrapper = this.archiveFolderInput.closest(".phg-input-wrapper");
      if (inputWrapper) {
        const btn = inputWrapper.querySelector(".phg-create-folder-btn");
        if (btn) {
          btn.disabled = isArchiveDisabled;
        }
      }
    }
    
    // Toggle: Archive Prompts
    if (this.archivePromptsToggleInput) {
      this.archivePromptsToggleInput.checked = state.archivePromptsEnabled !== false;
      const isArchiveDisabled = !(state.archiveEnabled !== false);
      this.archivePromptsToggleInput.disabled = isArchiveDisabled;
      if (isArchiveDisabled) {
        this.archivePromptsToggleInput.closest(".phg-toggle")?.classList.add("phg-toggle--disabled");
      } else {
        this.archivePromptsToggleInput.closest(".phg-toggle")?.classList.remove("phg-toggle--disabled");
      }
    }
  }

  _buildLayout() {
    this.backdrop = createEl("div", "phg-dialog-backdrop phg-hidden");
    this.backdrop.dataset.phg = "history";

    this.dialog = createEl("div", "phg-dialog");

    const header = createEl("header", "phg-dialog__header");

    const titleBlock = createEl("div", "phg-dialog__titles");
    this.titleEl = createEl("div", "phg-dialog__title", TEXT.title);
    this.targetLabel = createEl("div", "phg-dialog__subtitle");
    titleBlock.append(this.titleEl, this.targetLabel);

    // --- Tabs in Header ---
    const tabs = createEl("div", "phg-tabs");

    // History Tab Button
    const historyBtn = document.createElement("button");
    historyBtn.className = "phg-tab-button";
    historyBtn.textContent = TEXT.tabHistory;
    historyBtn.dataset.tab = "history";
    historyBtn.addEventListener("click", () => this._switchTab("history"));
    this.historyTabBtn = historyBtn;

    // Settings Tab Button
    const settingsBtn = document.createElement("button");
    settingsBtn.className = "phg-tab-button";
    settingsBtn.textContent = TEXT.tabSettings;
    settingsBtn.dataset.tab = "settings";
    settingsBtn.addEventListener("click", () => this._switchTab("settings"));
    this.settingsTabBtn = settingsBtn;

    tabs.append(historyBtn, settingsBtn);

    const actions = createEl("div", "phg-dialog__actions");
    // We only need Refresh loop here or inside History view.
    // Global Header Actions: Close. (Refresh makes sense in header too).
    this.refreshBtn = this._createButton("🔄", "Reload history", () => this.refresh(), "ghost");
    this.refreshBtn.classList.add("phg-button--icon");

    this.closeBtn = this._createButton("×", TEXT.settingsClose, () => this.close(), "ghost");
    this.closeBtn.classList.add("phg-button--icon");

    actions.append(this.refreshBtn, this.closeBtn);

    // Insert tabs between title and actions
    header.append(titleBlock, tabs, actions);

    // --- Views ---
    this.historyView = createEl("div", "phg-history-view");

    this.statusEl = createEl("div", "phg-dialog__status");
    this.searchRow = this._buildSearchRow();
    this.listEl = createEl("div", "phg-history-list");
    this.historyView.append(this.statusEl, this.searchRow, this.listEl);

    this.settingsView = this._buildSettingsView();

    const body = createEl("div", "phg-dialog__body");
    // Override default body padding/style slightly for full view behavior if needed, or just append
    body.append(this.historyView, this.settingsView);

    this.dialog.append(header, body);
    this.backdrop.appendChild(this.dialog);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) {
        this.close();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.isOpen) {
        this.close();
      }
    });
  }

  _createButton(label, title, onClick, variant = "primary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `phg-button phg-button--${variant}`;
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick?.();
    });
    return button;
  }

  _createIconButton(icon, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "phg-icon-btn";
    button.textContent = icon;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick?.();
    });
    return button;
  }

  _createChip(label, variant = "", onClick = null) {
    const chip = document.createElement("span");
    chip.className = "phg-chip" + (variant ? ` phg-chip--${variant}` : "");
    chip.textContent = label;
    if (typeof onClick === "function") {
      chip.classList.add("phg-chip--clickable");
      chip.setAttribute("role", "button");
      chip.tabIndex = 0;
      const handler = (event) => {
        event.stopPropagation();
        onClick();
      };
      chip.addEventListener("click", handler);
      chip.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handler(event);
        }
      });
    }
    return chip;
  }

  _buildSearchRow() {
    const row = createEl("div", "phg-search");
    const input = document.createElement("input");
    input.type = "search";
    input.className = "phg-search__input";
    input.placeholder = TEXT.searchPlaceholder;
    input.value = this.state.searchQuery;
    input.addEventListener("input", () => {
      this.state.searchQuery = input.value;
      this._renderEntries();
    });

    const modeBtn = this._createButton(
      this.state.searchMode.toUpperCase(),
      this.state.searchMode === "and" ? TEXT.searchModeAnd : TEXT.searchModeOr,
      () => {
        this.state.searchMode = this.state.searchMode === "and" ? "or" : "and";
        modeBtn.textContent = this.state.searchMode.toUpperCase();
        modeBtn.title = this.state.searchMode === "and" ? TEXT.searchModeAnd : TEXT.searchModeOr;
        modeBtn.setAttribute("aria-pressed", this.state.searchMode === "or");
        this._renderEntries();
      },
      "ghost"
    );
    modeBtn.classList.add("phg-search__mode");
    modeBtn.setAttribute("aria-pressed", this.state.searchMode === "or");

    const clearBtn = this._createButton(
      "×",
      TEXT.searchClear,
      () => {
        input.value = "";
        this.state.searchQuery = "";
        this._renderEntries();
        input.focus();
      },
      "ghost"
    );
    clearBtn.classList.add("phg-search__clear");

    const icon = createEl("span", "phg-search__icon", "🔍");
    row.append(icon, input, modeBtn, clearBtn);
    this.searchInput = input;
    return row;
  }

  _buildActions(entry, sources) {
    const hasImages = Array.isArray(sources) && sources.length > 0;
    const actions = createEl("div", "phg-entry-card__actions");

    const useLabel = this.state.target ? "Use" : "Copy";
    actions.append(
      this._createButton("Save Image", "Save file with dialog", () => this._handleSaveImage(entry, sources), "success"),
      this._createButton("Save Prompt", "Save prompt to text file", () => this._savePrompt(entry), "success"),
      this._createButton(
        useLabel,
        this.state.target ? "Send prompt to the selected node" : "Copy prompt to clipboard",
        () => this._handleUse(entry)
      ),
      this._createButton("Copy", "Copy full prompt structure", () => this._copyAllPrompts(entry)),
      this._createButton("Delete", "Delete entry", () => this._deleteEntry(entry), "danger")
    );

    return actions;
  }

  _buildPreview(preview, entry, sources) {
    const box = createEl("div", "phg-entry-card__preview");
    if (!preview) {
      box.append(createEl("div", "phg-preview-placeholder", "No image"));
      return box;
    }
    const img = createEl("img");
    img.src = preview.thumb ?? preview.url;
    img.alt = preview.title ?? "Generated image";
    img.loading = "lazy";
    img.addEventListener("click", (event) => {
      event.stopPropagation();
      this._openGallery(entry, sources.length - 1);
    });
    box.append(img);
    return box;
  }

  _buildPrompt(text) {
    const container = createEl("div", "phg-entry-card__prompt");
    const pre = createEl("pre");
    pre.textContent = text ?? "";

    // Make focusable so we can intercept events.
    pre.tabIndex = 0;

    container.append(pre);
    return container;
  }

  _dialogHasFocus() {
    if (!this.dialog) return false;
    const active = document.activeElement;
    if (active && this.dialog.contains(active)) return true;
    const selection = window.getSelection?.();
    if (!selection) return false;
    if (selection.anchorNode && this.dialog.contains(selection.anchorNode)) return true;
    if (selection.focusNode && this.dialog.contains(selection.focusNode)) return true;
    return false;
  }

  _shouldBlockComfyClipboard(event = null) {
    if (!this.state.isOpen) return false;
    if (!this._dialogHasFocus()) return false;
    if (!event) return true;
    if (!event.ctrlKey && !event.metaKey) return false;
    const key = event.key?.toLowerCase();
    const code = event.code?.toLowerCase();
    return key === "c" || key === "v" || code === "keyc" || code === "keyv";
  }

  _installComfyShortcutGuard() {
    if (this._comfyShortcutGuard) return;
    const guard = { restores: [] };
    const dialog = this;

    const wrap = (obj, name, wrapper) => {
      if (!obj || typeof obj[name] !== "function") return;
      const original = obj[name];
      if (original.__phgWrapped) return;
      const wrapped = function (...args) {
        return wrapper.call(this, original, ...args);
      };
      wrapped.__phgWrapped = true;
      wrapped.__phgOriginal = original;
      obj[name] = wrapped;
      guard.restores.push(() => {
        obj[name] = original;
      });
    };

    const wrapKeyHandler = (obj, name) => {
      wrap(obj, name, function (original, event, ...rest) {
        if (dialog._shouldBlockComfyClipboard(event)) {
          return false;
        }
        return original.call(this, event, ...rest);
      });
    };

    const wrapClipboard = (obj, name) => {
      wrap(obj, name, function (original, ...args) {
        if (dialog._shouldBlockComfyClipboard()) {
          return undefined;
        }
        return original.apply(this, args);
      });
    };

    const comfyApp = this.comfyApp ?? resolveComfyApp();
    const canvas = comfyApp?.canvas ?? null;
    const proto =
      window.LGraphCanvas?.prototype ?? window.LiteGraph?.LGraphCanvas?.prototype ?? null;

    [canvas, proto].forEach((target) => {
      wrapKeyHandler(target, "onKeyDown");
      wrapKeyHandler(target, "processKey");
      wrapClipboard(target, "copyToClipboard");
      wrapClipboard(target, "pasteFromClipboard");
    });

    this._comfyShortcutGuard = guard;
  }

  _removeComfyShortcutGuard() {
    const guard = this._comfyShortcutGuard;
    if (!guard) return;
    for (const restore of guard.restores.reverse()) {
      try {
        restore();
      } catch (error) {
        logError(LOGGER, "comfy shortcut guard restore error", error);
      }
    }
    this._comfyShortcutGuard = null;
  }

  _setLoading(value) {
    this.state.loading = Boolean(value);
    this.refreshBtn.disabled = this.state.loading;
  }

  _setMessage(text, tone = "") {
    if (this.messageTimeout) {
      clearTimeout(this.messageTimeout);
      this.messageTimeout = null;
    }
    this.statusEl.textContent = text || "";
    this.statusEl.dataset.tone = tone || "";
    if (text) {
      this.messageTimeout = setTimeout(() => {
        this.statusEl.textContent = "";
      }, 3200);
    }
  }

  _updateTargetLabel() {
    const target = this.state.target;
    if (target) {
      this.targetLabel.textContent = TEXT.subtitleTarget(target.nodeTitle);
    } else {
      this.targetLabel.textContent = TEXT.subtitleMissing;
    }
  }

  _renderEntries() {
    this.listEl.innerHTML = "";

    const entries = this._filterEntries(this.state.entries);

    if (this.state.error) {
      this.listEl.appendChild(this._renderMessage(this.state.error, "error"));
      return;
    }

    if (this.state.loading) {
      this.listEl.appendChild(this._renderMessage(TEXT.loading, "muted"));
      return;
    }

    if (!entries.length && this.state.entries.length) {
      this.listEl.appendChild(this._renderMessage(TEXT.searchNoResults, "muted"));
      return;
    }

    if (!entries.length) {
      this.listEl.appendChild(this._renderMessage(TEXT.empty, "muted"));
      return;
    }

    const preparedEntries = entries.map((entry) => {
      const sources = buildImageSources(entry, this.api);
      return {
        entry,
        sources,
        imageCount: sources.length,
      };
    });

    const maxImages = preparedEntries.reduce((max, item) => Math.max(max, item.imageCount), 0);
    const highlightEnabled = this.settingsState?.highlightUsage !== false;
    const startCount = clamp(
      Number(
        this.settingsState?.highlightUsageStartCount ??
          DEFAULT_SETTINGS.highlightUsageStartCount ??
          5
      ),
      USAGE_START_MIN,
      USAGE_START_MAX
    );
    const ratio = clamp(
      Number(
        this.settingsState?.highlightUsageRatio ?? DEFAULT_SETTINGS.highlightUsageRatio ?? 0.8
      ),
      USAGE_RATIO_MIN,
      USAGE_RATIO_MAX
    );
    const fullGlowAt =
      maxImages > 1 ? Math.max(startCount + 1, Math.round(maxImages * ratio)) : null;

    for (const item of preparedEntries) {
      const highlight =
        highlightEnabled && maxImages >= startCount && item.imageCount >= startCount;

      const strength = (() => {
        if (!highlight || !maxImages || !fullGlowAt || fullGlowAt <= startCount) {
          return 0;
        }
        const numerator = item.imageCount - startCount;
        const denom = fullGlowAt - startCount;
        if (denom <= 0) return 1;
        return clamp(numerator / denom, 0, 1);
      })();

      this.listEl.appendChild(
        this._renderEntry(item.entry, item.sources, {
          imageCount: item.imageCount,
          maxImages,
          highlight,
          highlightStrength: Number.isFinite(strength) ? strength : 0,
          highlightThreshold: fullGlowAt,
        })
      );
    }
  }

  _renderMessage(text, tone = "") {
    const box = document.createElement("div");
    box.className = "phg-message" + (tone ? ` phg-message--${tone}` : "");
    box.textContent = text;
    return box;
  }

  _filterEntries(entries) {
    if (!Array.isArray(entries) || !entries.length) return [];
    const query = (this.state.searchQuery ?? "").trim().toLowerCase();
    if (!query) return entries;
    const terms = query
      .split(/[\s,]+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (!terms.length) return entries;
    const isOrMode = this.state.searchMode === "or";
    return entries.filter((entry) => {
      const promptText = String(entry.prompt ?? "").toLowerCase();
      const negativePromptText = String(entry.negative_prompt ?? "").toLowerCase();
      const combinedText = promptText + " " + negativePromptText;
      const matchesTerm = (term) => combinedText.includes(term);
      return isOrMode ? terms.some(matchesTerm) : terms.every(matchesTerm);
    });
  }

  _renderEntry(entry, sourcesArg = null, usageMeta = {}) {
    const article = createEl("article", "phg-entry-card");

    const sources = Array.isArray(sourcesArg) ? sourcesArg : buildImageSources(entry, this.api);
    const hasImages = sources.length > 0;
    const preview = hasImages ? sources[sources.length - 1] : null; // latest

    const imageCount = usageMeta.imageCount ?? sources.length;
    const maxImages = usageMeta.maxImages ?? imageCount;
    const highlight = Boolean(usageMeta.highlight);
    const threshold = usageMeta.highlightThreshold;
    const strength = clamp(Number(usageMeta.highlightStrength ?? 0), 0, 1);

    if (highlight) {
      article.classList.add("phg-entry-card--popular");
      article.style.setProperty("--phg-usage-strength", String(strength));
      article.dataset.usageCount = String(imageCount);
      if (maxImages) {
        article.dataset.usageMax = String(maxImages);
      }
      if (threshold) {
        article.dataset.usageThreshold = String(threshold);
      }
    }

    const header = createEl("div", "phg-entry-card__header");
    const stamp = createEl(
      "div",
      "phg-entry-card__stamp",
      formatTimestamp(entry?.last_used_at ?? entry?.created_at)
    );
    const badges = createEl("div", "phg-entry-card__badges");
    const imagesChip = this._createChip(
      imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : "No images",
      hasImages ? "accent" : "muted",
      hasImages ? () => this._openGallery(entry, sources.length - 1) : null
    );

    imagesChip.title = hasImages
      ? highlight && Number.isFinite(threshold) && maxImages
        ? `Frequent prompt: ${imageCount} images (top ${maxImages}, full glow at ≥ ${threshold}). Click to open.`
        : "Open generated images"
      : TEXT.noImages;
    badges.append(imagesChip);
    header.append(stamp, badges, this._buildActions(entry, sources));

    const body = createEl("div", "phg-entry-card__body");
    body.append(
      this._buildPreview(preview, entry, sources),
      this._buildPromptContainer(entry)
    );

    const metaRow = createEl("div", "phg-entry-card__footer");

    article.append(header, body, metaRow);
    return article;
  }

  _buildPromptContainer(entry) {
    const container = createEl("div", "phg-prompt-container");
    
    // Positive prompt section (with green border like negative has red)
    const posContainer = createEl("div", "phg-prompt-section phg-prompt-section--positive");
    const posHeader = createEl("div", "phg-prompt-header");
    const posLabel = createEl("div", "phg-prompt-label", "POSITIVE PROMPT:");
    const posCopyBtn = this._createIconButton("📋", "Copy positive prompt", () => this._copyIndividualPrompt(entry.prompt, "Positive"));
    posHeader.append(posLabel, posCopyBtn);
    const posPre = createEl("pre", "phg-prompt-text");
    posPre.textContent = entry.prompt ?? "";
    posContainer.append(posHeader, posPre);
    
    // Negative prompt section (always show, even if empty)
    const negContainer = createEl("div", "phg-prompt-section phg-prompt-section--negative");
    const negHeader = createEl("div", "phg-prompt-header");
    const negLabel = createEl("div", "phg-prompt-label", "NEGATIVE PROMPT:");
    const negCopyBtn = this._createIconButton("📋", "Copy negative prompt", () => this._copyIndividualPrompt(entry.negative_prompt, "Negative"));
    negHeader.append(negLabel, negCopyBtn);
    const negPre = createEl("pre", "phg-prompt-text");
    negPre.textContent = entry.negative_prompt ?? "";
    negContainer.append(negHeader, negPre);
    container.append(posContainer, negContainer);

    return container;
  }

  async _handleUse(entry) {
    if (!entry) return;
    const target = this.state.target;
    if (!target) {
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedFallback, "info");
      this.close();
      return;
    }

    let node = resolveNodeFromTarget(target);
    if (!node) {
      this.state.target = null;
      this._updateTargetLabel();
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedMissingNode, "warn");
      this.close();
      return;
    }

    let widget =
      node.widgets?.find((item) => item?.name === target.widgetName) ?? resolvePromptWidget(node);

    // --- NEW LOGIC START ---
    // If the widget is connected to an input, traverse upstream.
    // We do this in a loop to handle chains of reroutes or similar nodes if needed,
    // though the requirement says "if the input field is input from another node".
    // We'll just check one level or traverse until we find a free widget.

    const MAX_TRAVERSAL = 10;
    let traversalCount = 0;

    while (widget && traversalCount < MAX_TRAVERSAL) {
      // Check if this widget corresponds to a connected input
      const input = node.inputs?.find((i) => i.name === widget.name);
      if (input && input.link) {
        // It is connected. Find the upstream node.
        const upstreamNode = resolveUpstreamConnection(node, widget.name);
        if (upstreamNode) {
          // Switch focus to the upstream node
          node = upstreamNode;
          // Try to find a suitable widget on the new node.
          // The requirement says: "If the input node has multiple string input fields, try to enter from the top."
          // "If the input node also has an input field input from another node, ignore that input field and enter the next input field."
          widget = findFirstFreeStringWidget(node);
          traversalCount++;
          if (!widget) {
            // Upstream node has no free widgets. Stop here? Or keep searching?
            // For now, if we can't find a free widget on the upstream node, we can't "Use" it there.
            // We might fall back to copying.
            break;
          }
        } else {
          // Connected but can't resolve upstream?
          break;
        }
      } else {
        // Not connected, so this widget is free to use.
        break;
      }
    }
    // --- NEW LOGIC END ---

    if (!widget) {
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedMissingWidget, "warn");
      this.close();
      return;
    }

    // Apply positive prompt
    const updated = applyPromptToWidget(node, widget, entry.prompt ?? "");
    
    // Apply negative prompt if it exists and we can find another widget
    if (entry.negative_prompt && entry.negative_prompt.trim() !== "") {
      // Try to find another free string widget for negative prompt
      let negWidget = findFirstFreeStringWidget(node);
      // If the first free widget is the same as the one we used for positive, try to find another
      if (negWidget === widget) {
        // Look for the next available widget
        const allWidgets = node.widgets?.filter((w) => 
          w.type === "string" || w.type === "customtext"
        ) || [];
        const widgetIndex = allWidgets.indexOf(widget);
        if (widgetIndex >= 0 && widgetIndex < allWidgets.length - 1) {
          negWidget = allWidgets[widgetIndex + 1];
        } else {
          negWidget = null;
        }
      }
      
      if (negWidget && negWidget !== widget) {
        applyPromptToWidget(node, negWidget, entry.negative_prompt);
      }
    }
    
    // Update target to point to where we actually sent it, so the UI reflects it?
    // The requirement doesn't explicitly say we must update the "Sending to: ..." label permanently,
    // but it's good UX to show where it went.
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();

    if (updated) {
      this._setMessage(TEXT.sent(this.state.target?.nodeTitle), "success");
    } else {
      this._setMessage(TEXT.same, "muted");
    }
    this.close();
  }

  async _copyPrompt(entry) {
    try {
      // Copy only positive prompt without header (original behavior for individual copy)
      const textToCopy = entry.prompt ?? "";
      await navigator.clipboard.writeText(textToCopy);
      this._setMessage(TEXT.copied, "info");
    } catch (error) {
      logError(LOGGER, "copyPrompt error", error);
      this._setMessage("Failed to copy prompt.", "error");
    }
  }

  async _copyIndividualPrompt(text, type) {
    try {
      const textToCopy = text ?? "";
      await navigator.clipboard.writeText(textToCopy);
      this._setMessage(`${type} prompt copied.`, "info");
    } catch (error) {
      logError(LOGGER, "copyIndividualPrompt error", error);
      this._setMessage(`Failed to copy ${type.toLowerCase()} prompt.`, "error");
    }
  }

  async _copyAllPrompts(entry) {
    try {
      // Copy both positive and negative prompts with headers (same format as Save Prompt)
      const positivePrompt = entry.prompt ?? "";
      const negativePrompt = entry.negative_prompt ?? "";
      
      const textToCopy = `POSITIVE PROMPT:\n${positivePrompt}\n\nNEGATIVE PROMPT:\n${negativePrompt}`;
      await navigator.clipboard.writeText(textToCopy);
      this._setMessage("Full prompt structure copied.", "info");
    } catch (error) {
      logError(LOGGER, "copyAllPrompts error", error);
      this._setMessage("Failed to copy prompts.", "error");
    }
  }

  async _handleSaveImage(entry, sources) {
    if (!sources || sources.length === 0) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    
    // If multiple images, open gallery for selection
    if (sources.length > 1) {
      this._openGallery(entry, sources.length - 1);
      return;
    }
    
    // Single image - save directly
    await this._saveFileFromSource(sources[sources.length - 1], entry);
  }

  async _saveFileFromSource(source, entry) {
    try {
      const url = source.url;
      
      // Fetch the image blob
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to fetch image");
      }
      const blob = await response.blob();
      
      // Create download link and trigger save dialog
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      // Generate filename from entry id or timestamp
      const filename = `prompt_${entry.id || Date.now()}.png`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      this._setMessage(TEXT.saveSuccess, "success");
    } catch (error) {
      logError(LOGGER, "saveFile error", error);
      this._setMessage(TEXT.saveError, "error");
    }
  }

  // Method called from viewer gallery to save selected image
  async saveSelectedImageFromGallery(imageElement) {
    try {
      const src = imageElement.src || imageElement.getAttribute("data-original");
      if (!src) {
        throw new Error("No image source found");
      }
      
      // Fetch the image blob
      const response = await fetch(src);
      if (!response.ok) {
        throw new Error("Failed to fetch image");
      }
      const blob = await response.blob();
      
      // Create download link and trigger save dialog
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      const entryId = imageElement.dataset.entryId || Date.now();
      a.download = `prompt_${entryId}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      this._setMessage(TEXT.saveSuccess, "success");
    } catch (error) {
      logError(LOGGER, "saveGalleryImage error", error);
      this._setMessage(TEXT.saveError, "error");
    }
  }

  async _saveFile(entry) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    try {
      // Use the latest image
      const latestSource = sources[sources.length - 1];
      await this._saveFileFromSource(latestSource, entry);
    } catch (error) {
      logError(LOGGER, "saveFile error", error);
      this._setMessage(TEXT.saveError, "error");
    }
  }

  async _deleteEntry(entry) {
    if (!entry?.id) return;
    if (!window.confirm(TEXT.deleteConfirm)) return;
    try {
      await this.historyApi.remove(entry.id);
      this.state.entries = this.state.entries.filter((item) => item.id !== entry.id);
      this.viewer.close();
      this._renderEntries();
      this._setMessage(TEXT.deleteSuccess, "success");
    } catch (error) {
      logError(LOGGER, "delete error", error);
      this._setMessage(TEXT.deleteError, "error");
    }
  }

  async _openGallery(entry, startIndex = 0) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    try {
      await this.viewer.open(entry.id ?? null, sources, Math.max(0, startIndex), entry, this);
    } catch (error) {
      logError(LOGGER, "openGallery error", error);
      this._setMessage("Failed to open gallery.", "error");
    }
  }

  async _saveFile(entry) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    try {
      // Use the latest image
      const latestSource = sources[sources.length - 1];
      const url = latestSource.url;
      
      // Fetch the image blob
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to fetch image");
      }
      const blob = await response.blob();
      
      // Create download link and trigger save dialog
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      // Generate filename from entry id or timestamp
      const filename = `prompt_${entry.id || Date.now()}.png`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      this._setMessage(TEXT.saveSuccess, "success");
    } catch (error) {
      logError(LOGGER, "saveFile error", error);
      this._setMessage(TEXT.saveError, "error");
    }
  }

  async _savePrompt(entry) {
    try {
      // Format the prompt text as specified
      const positivePrompt = entry.prompt ?? "";
      const negativePrompt = entry.negative_prompt ?? "";
      
      const promptText = `POSITIVE PROMPT:\n${positivePrompt}\n\nNEGATIVE PROMPT:\n${negativePrompt}`;
      
      // Create blob and download
      const blob = new Blob([promptText], { type: "text/plain" });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      // Generate filename from entry id or timestamp
      const filename = `prompt_${entry.id || Date.now()}.txt`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      this._setMessage(TEXT.saveSuccess, "success");
    } catch (error) {
      logError(LOGGER, "savePrompt error", error);
      this._setMessage(TEXT.saveError, "error");
    }
  }
}

let dialogInstance = null;
let listenersAttached = false;
let previewNotifierInstance = null;

function ensureDialog() {
  if (!dialogInstance) {
    dialogInstance = new HistoryDialog({ api: resolveComfyApi(), comfyApp: resolveComfyApp() });
  }
  return dialogInstance;
}

function attachUpdateListeners(api, eventBus) {
  if (listenersAttached) return;
  const dialog = ensureDialog();
  previewNotifierInstance = createPreviewNotifier({
    api,
    historyApi: dialog.historyApi,
    logger: console,
    openGallery: (entry, sources, startIndex = 0) => {
      if (!dialog?.viewer || !Array.isArray(sources) || sources.length === 0) {
        return false;
      }
      const safeIndex = Math.max(0, Math.min(startIndex, sources.length - 1));
      try {
        const result = dialog.viewer.open(entry?.id ?? null, sources, safeIndex, entry, dialog);
        return result ?? true;
      } catch (error) {
        logError(LOGGER, "preview openGallery error", error);
        return false;
      }
    },
  });

  const handler = (event) => {
    dialog.refreshIfOpen();
    if (!previewNotifierInstance) return;
    try {
      const result =
        previewNotifierInstance.handleHistoryEvent?.(event) ??
        previewNotifierInstance.notifyEntryIds?.(extractEntryIds(event));
      if (result && typeof result.then === "function") {
        result.catch((error) => logError(LOGGER, "preview handler error", error));
      }
    } catch (error) {
      logError(LOGGER, "preview handler error", error);
    }
  };

  api?.addEventListener?.(HISTORY_UPDATE_EVENT, handler);
  eventBus?.on?.(HISTORY_UPDATE_EVENT, handler);
  listenersAttached = true;
}

function attachHistoryButton(node) {
  if (!node || typeof node.addWidget !== "function") return;
  const existing = Array.isArray(node.widgets)
    ? node.widgets.find(
        (widget) =>
          widget?.[HISTORY_WIDGET_FLAG] === true ||
          widget?.name === "phg_history" ||
          widget?.name === "History" ||
          widget?.name === HISTORY_WIDGET_LABEL
      )
    : null;
  const dialog = ensureDialog();
  const handler = () => dialog.openWithNode(node);
  if (existing) {
    existing.callback = handler;
    existing[HISTORY_WIDGET_FLAG] = true;
    existing.name = HISTORY_WIDGET_LABEL;
    return;
  }
  const widget = node.addWidget("button", HISTORY_WIDGET_LABEL, null, handler, {
    serialize: false,
  });
  if (widget) {
    widget[HISTORY_WIDGET_FLAG] = true;
    widget.name = HISTORY_WIDGET_LABEL;
  }
}

function registerExtension() {
  logInfo(LOGGER, "loading");
  const comfyApp = resolveComfyApp();
  const comfyApi = resolveComfyApi();

  if (comfyApp?.registerExtension) {
    comfyApp.registerExtension({
      name: EXTENSION_NAME,
      setup() {
        ensureDialog();
        attachUpdateListeners(comfyApi, comfyApp?.eventBus ?? null);
      },
      beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "PromptHistoryInput") return;
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
          const result = onCreated?.apply(this, args);
          attachHistoryButton(this);
          return result;
        };
      },
    });
    return;
  }

  // Fallback for older frontends without registerExtension hook.
  ensureDialog();
  attachUpdateListeners(comfyApi, comfyApp?.eventBus ?? null);
  const originalRegisterNode = window?.LiteGraph?.registerNodeType;
  if (originalRegisterNode) {
    window.LiteGraph.registerNodeType = function (type, nodeType) {
      originalRegisterNode.call(window.LiteGraph, type, nodeType);
      if (nodeType?.title === "Prompt History Input" || type?.endsWith("PromptHistoryInput")) {
        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
          const res = onCreated?.apply(this, args);
          attachHistoryButton(this);
          return res;
        };
      }
    };
  }
}

registerExtension();
