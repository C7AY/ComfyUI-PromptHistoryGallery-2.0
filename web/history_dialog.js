import { createHistoryApi } from "./lib/historyApi.js";
import { buildImageSources } from "./lib/imageSources.js";
import { createCustomViewer } from "./lib/customViewer.js";
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
  sectionArchive: "Archive Settings",
  archiveToggle: "Enable Image Archiving",
  archiveFolderLabel: "Archive Folder Name",
  archiveFolderHint: "Folder name for archived images (relative to ComfyUI output directory)",
  archivePromptsToggle: "Save Prompts as Text Files",
  archivePromptsHint: "Save positive and negative prompts to .txt files alongside archived images",
  searchPlaceholder: "Search prompts…",
  searchClear: "Clear search",
  searchModeAnd: "Match ALL words",
  searchModeOr: "Match ANY word",
  searchNoResults: "No results found.",
};

const USAGE_RATIO_MIN = 0.05;
const USAGE_RATIO_MAX = 1;
const USAGE_START_MIN = 1;
const USAGE_START_MAX = 100;

const LOGGER = console;

class HistoryDialog {
  constructor({ api, comfyApp }) {
    ensureStylesheet();
    this.api = api ?? resolveComfyApi();
    this.comfyApp = comfyApp ?? resolveComfyApp();
    this.historyApi = createHistoryApi(this.api);
    this.viewer = createCustomViewer();
    this.settingsStore = getPreviewSettingsStore();
    this.settingsState = this.settingsStore?.getState?.() ?? DEFAULT_SETTINGS;
    this.unsubscribeSettings =
      this.settingsStore?.subscribe?.((next) => {
        const previous = this.settingsState;
        this.settingsState = next ?? this.settingsState;
        this._syncSettingsUI();
        if (previous?.archiveEnabled !== this.settingsState?.archiveEnabled && this.state?.isOpen) {
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
    this._switchTab("history");
    
    this._initArchiveSettings();
  }
  
  async _initArchiveSettings() {
    await this._syncArchiveSettingsToServerSilent();
    await this._syncArchiveSettingsFromServer();
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
      const items = await this.historyApi.list();
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
    // Лимитов больше нет - возвращаем все записи
    return null;
  }

  _switchTab(tabId) {
    this.state.activeTab = tabId;
    [this.historyTabBtn, this.settingsTabBtn].forEach((btn) => {
      if (btn) btn.dataset.active = btn.dataset.tab === tabId ? "true" : "false";
    });
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

  _resetSettings() {
    if (!this.settingsStore?.reset) return;
    this.settingsStore.reset();
    this.settingsState = this.settingsStore.getState?.() ?? DEFAULT_SETTINGS;
    this._syncSettingsUI();
    this._syncArchiveSettingsToServer();
  }

  _applySettingsPatch(patch) {
    if (!patch || typeof patch !== "object") return;
    this.settingsStore?.update?.(patch);
    this.settingsState = this.settingsStore?.getState?.() ?? this.settingsState;
    this._syncSettingsUI();
    
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
      if (!response.ok) console.error("[PHG] Failed to sync archive settings to server");
    } catch (error) {
      console.error("[PHG] Error syncing archive settings:", error);
    }
  }
  
  async _syncArchiveSettingsToServerSilent() {
    try {
      const payload = {
        enabled: this.settingsState?.archiveEnabled ?? false,
        folder_name: this.settingsState?.archiveFolderName ?? "archive",
        prompts_enabled: this.settingsState?.archivePromptsEnabled ?? false,
      };
      await this.api.fetchApi("/prompt-history-gallery/archive-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error("[PHG] Error syncing archive settings:", error);
    }
  }
  
  async _syncArchiveSettingsFromServer() {
    try {
      const response = await this.api.fetchApi("/prompt-history-gallery/archive-settings");
      if (!response.ok) return;
      
      const data = await response.json();
      if (data.success && data.settings) {
        const serverSettings = data.settings;
        const patch = {};
        if (typeof serverSettings.enabled === "boolean") patch.archiveEnabled = serverSettings.enabled;
        if (typeof serverSettings.folder_name === "string" && serverSettings.folder_name.trim()) {
          patch.archiveFolderName = serverSettings.folder_name.trim();
        }
        if (typeof serverSettings.prompts_enabled === "boolean") {
          patch.archivePromptsEnabled = serverSettings.prompts_enabled;
        }
        
        if (Object.keys(patch).length > 0) {
          this.settingsStore?.update?.(patch);
          this.settingsState = this.settingsStore?.getState?.() ?? this.settingsState;
        }
      }
    } catch (error) {
      console.error("[PHG] Error fetching archive settings from server:", error);
    }
  }
  
  async _syncWAL() {
    try {
      const response = await this.api.fetchApi("/phg/sync_wal_to_db", { method: "POST" });
      const data = await response.json();
      
      if (data.success) {
        this._setMessage(`WAL synced: DB=${data.db_size} bytes, WAL=${data.wal_size} bytes`, "success");
        // После синхронизации обновляем список записей
        setTimeout(() => this.refresh(), 500);
      } else {
        this._setMessage("WAL sync failed: " + (data.error || "Unknown error"), "error");
      }
    } catch (error) {
      logError(LOGGER, "WAL sync error", error);
      this._setMessage("WAL sync error: " + error.message, "error");
    }
  }
  
  async _createArchiveFolder(folderName) {
    const messageEl = this.archiveFolderMessage;
    if (!messageEl) return;
    
    messageEl.classList.remove("phg-field-message--success", "phg-field-message--error", "phg-field-message--hidden");
    messageEl.textContent = "";
    
    const safeFolderName = (folderName || "archive").trim();
    if (!safeFolderName) {
      messageEl.textContent = "Please enter a valid folder name";
      messageEl.classList.add("phg-field-message--error");
      return;
    }
    
    try {
      const response = await this.api.fetchApi("/prompt-history-gallery/create-archive-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_name: safeFolderName }),
      });
      
      if (response.status === 409) {
        messageEl.textContent = `✓ Folder '${safeFolderName}' already exists`;
        messageEl.classList.add("phg-field-message--success");
      } else if (response.ok) {
        messageEl.textContent = `✓ Folder '${safeFolderName}' created successfully`;
        messageEl.classList.add("phg-field-message--success");
        await this._syncArchiveSettingsToServer();
      } else {
        messageEl.textContent = `✗ Failed to create folder`;
        messageEl.classList.add("phg-field-message--error");
      }
    } catch (error) {
      console.error("[PHG] Error creating archive folder:", error);
      messageEl.textContent = `✗ Error: ${error.message}`;
      messageEl.classList.add("phg-field-message--error");
    }
  }

  async _importArchiveMetadata() {
    const messageEl = this.importMetadataMessage;
    if (!messageEl) return;
    
    messageEl.classList.remove("phg-field-message--success", "phg-field-message--error", "phg-field-message--hidden");
    messageEl.textContent = "";
    
    try {
      messageEl.textContent = "Extracting metadata from archive images...";
      messageEl.classList.add("phg-field-message--muted");
      
      const response = await this.api.fetchApi("/phg/import_archive_metadata", {
        method: "POST",
      });
      
      const result = await response.json();
      
      if (response.ok && result.success) {
        const { updated_count, processed_count, not_found_count, message } = result;
        
        if (updated_count > 0) {
          messageEl.textContent = `✓ ${message} (${processed_count} images processed, ${not_found_count} not matched)`;
          messageEl.classList.add("phg-field-message--success");
          
          // Refresh history to show updated metadata
          setTimeout(() => this.refresh(), 500);
        } else {
          messageEl.textContent = message || "No metadata found in archive images";
          messageEl.classList.add("phg-field-message--muted");
        }
      } else {
        messageEl.textContent = `✗ ${result.error || "Failed to import metadata"}`;
        messageEl.classList.add("phg-field-message--error");
      }
    } catch (error) {
      console.error("[PHG] Error importing archive metadata:", error);
      messageEl.textContent = `✗ Error: ${error.message}`;
      messageEl.classList.add("phg-field-message--error");
    }
  }

  _buildSettingsView() {
    const container = createEl("div", "phg-settings-container phg-hidden");
    
    // Archive Settings Group
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
        (val) => {
          const sanitized = val.replace(/[^a-zA-Z0-9]/g, '');
          this._applySettingsPatch({ archiveFolderName: sanitized || "archive" });
        },
        "archiveFolderInput",
        {
          label: "Create Folder",
          title: "Create archive folder in output directory",
          messageRef: "archiveFolderMessage",
          onClick: (folderName) => this._createArchiveFolder(folderName),
        },
        () => !(this.settingsState?.archiveEnabled !== false)
      ),
      this._buildToggleField(
        TEXT.archivePromptsToggle,
        () => this.settingsState?.archivePromptsEnabled !== false,
        (checked) => this._applySettingsPatch({ archivePromptsEnabled: checked }),
        "archivePromptsToggleInput",
        () => !(this.settingsState?.archiveEnabled !== false)
      ),
      // Import Metadata from Archive button
      this._buildButtonField(
        "Import Metadata from Archive",
        "Extract metadata from archived images and update database records",
        "Import Metadata",
        () => this._importArchiveMetadata(),
        "importMetadataMessage"
      ),
    ]);

    const footer = createEl("div", "phg-settings-footer");
    footer.append(this._createButton(TEXT.settingsReset, "Restore defaults", () => this._resetSettings(), "ghost"));
    container.append(archiveGroup, footer);
    return container;
  }

  _buildSettingsGroup(title, items) {
    const group = createEl("div", "phg-settings-group");
    const header = createEl("div", "phg-settings-group__header");
    header.append(createEl("div", "phg-settings-group__title", title));
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
    if (isDisabled) toggle.classList.add("phg-toggle--disabled");
    
    const toggleLabelEl = toggle;
    input.addEventListener("change", () => {
      onChange(input.checked);
      if (disabledWhen) {
        const shouldBeDisabled = disabledWhen();
        input.disabled = shouldBeDisabled;
        if (shouldBeDisabled) toggleLabelEl.classList.add("phg-toggle--disabled");
        else toggleLabelEl.classList.remove("phg-toggle--disabled");
      }
    });

    toggle.append(input, createEl("span", "phg-toggle-slider"));
    control.append(toggle);
    item.append(info, control);
    if (refName) this[refName] = input;
    return item;
  }

  _buildTextField(label, hint, getValue, onChange, refName, addButton, disabledWhen) {
    const item = createEl("div", "phg-settings-item phg-settings-item--col");
    const headerObj = createEl("div", "phg-settings-item__header");
    headerObj.append(createEl("div", "phg-settings-item__label", label));

    const control = createEl("div", "phg-range-wrapper");
    const inputWrapper = createEl("div", "phg-input-wrapper");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "phg-text-input";
    input.value = getValue();
    input.placeholder = hint;
    
    const isDisabled = disabledWhen ? disabledWhen() : false;
    input.disabled = isDisabled;

    if (addButton) {
      input.addEventListener("change", () => { if (!isDisabled) onChange(input.value.trim()); });
    } else {
      input.addEventListener("input", () => { if (!isDisabled) onChange(input.value); });
      input.addEventListener("change", () => { if (!isDisabled) onChange(input.value.trim()); });
    }

    inputWrapper.append(input);
    
    if (addButton) {
      const btn = document.createElement("button");
      btn.className = "phg-button phg-button--success";
      btn.textContent = addButton.label;
      btn.title = addButton.title || "";
      btn.disabled = isDisabled;
      btn.addEventListener("click", () => { if (!isDisabled) addButton.onClick(input.value.trim()); });
      inputWrapper.append(btn);
    }

    control.append(inputWrapper);
    item.append(headerObj, control);
    
    const messageEl = createEl("div", "phg-field-message phg-field-message--hidden");
    item.append(messageEl);

    if (refName) this[refName] = input;
    if (addButton && addButton.messageRef) this[addButton.messageRef] = messageEl;
    
    return item;
  }

  _buildButtonField(label, hint, buttonText, onClick, messageRef) {
    const item = createEl("div", "phg-settings-item phg-settings-item--col");
    const headerObj = createEl("div", "phg-settings-item__header");
    headerObj.append(createEl("div", "phg-settings-item__label", label));
    headerObj.append(createEl("div", "phg-settings-item__hint", hint));

    const control = createEl("div", "phg-range-wrapper");
    const btn = document.createElement("button");
    btn.className = "phg-button phg-button--primary";
    btn.textContent = buttonText;
    btn.addEventListener("click", onClick);

    control.append(btn);
    item.append(headerObj, control);
    
    const messageEl = createEl("div", "phg-field-message phg-field-message--hidden");
    item.append(messageEl);

    if (messageRef) this[messageRef] = messageEl;
    
    return item;
  }

  _syncSettingsUI() {
    const state = this.settingsStore?.getState?.() ?? this.settingsState ?? DEFAULT_SETTINGS;
    this.settingsState = state;

    if (this.archiveToggleInput) this.archiveToggleInput.checked = state.archiveEnabled !== false;

    if (this.archiveFolderInput) {
      this.archiveFolderInput.value = state.archiveFolderName ?? DEFAULT_SETTINGS.archiveFolderName;
      const isArchiveDisabled = !(state.archiveEnabled !== false);
      this.archiveFolderInput.disabled = isArchiveDisabled;
      const inputWrapper = this.archiveFolderInput.closest(".phg-input-wrapper");
      if (inputWrapper) {
        const btn = inputWrapper.querySelector(".phg-create-folder-btn");
        if (btn) btn.disabled = isArchiveDisabled;
      }
    }
    
    if (this.archivePromptsToggleInput) {
      this.archivePromptsToggleInput.checked = state.archivePromptsEnabled !== false;
      const isArchiveDisabled = !(state.archiveEnabled !== false);
      this.archivePromptsToggleInput.disabled = isArchiveDisabled;
      if (isArchiveDisabled) this.archivePromptsToggleInput.closest(".phg-toggle")?.classList.add("phg-toggle--disabled");
      else this.archivePromptsToggleInput.closest(".phg-toggle")?.classList.remove("phg-toggle--disabled");
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

    const tabs = createEl("div", "phg-tabs");
    const historyBtn = document.createElement("button");
    historyBtn.className = "phg-tab-button";
    historyBtn.textContent = TEXT.tabHistory;
    historyBtn.dataset.tab = "history";
    historyBtn.addEventListener("click", () => this._switchTab("history"));
    this.historyTabBtn = historyBtn;

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "phg-tab-button";
    settingsBtn.textContent = TEXT.tabSettings;
    settingsBtn.dataset.tab = "settings";
    settingsBtn.addEventListener("click", () => this._switchTab("settings"));
    this.settingsTabBtn = settingsBtn;

    tabs.append(historyBtn, settingsBtn);

    const actions = createEl("div", "phg-dialog__actions");
    this.syncBtn = this._createButton("🤝", "Sync WAL to DB", () => this._syncWAL(), "ghost");
    this.syncBtn.classList.add("phg-button--icon");
    this.refreshBtn = this._createButton("🔄", "Reload history", () => this.refresh(), "ghost");
    this.refreshBtn.classList.add("phg-button--icon");
    this.closeBtn = this._createButton("×", TEXT.settingsClose, () => this.close(), "ghost");
    this.closeBtn.classList.add("phg-button--icon");
    actions.append(this.syncBtn, this.refreshBtn, this.closeBtn);

    header.append(titleBlock, tabs, actions);

    this.historyView = createEl("div", "phg-history-view");
    this.statusEl = createEl("div", "phg-dialog__status");
    this.searchRow = this._buildSearchRow();
    this.listEl = createEl("div", "phg-history-list");
    this.historyView.append(this.statusEl, this.searchRow, this.listEl);

    this.settingsView = this._buildSettingsView();

    const body = createEl("div", "phg-dialog__body");
    body.append(this.historyView, this.settingsView);

    this.dialog.append(header, body);
    this.backdrop.appendChild(this.dialog);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener("click", (event) => {
      if (event.target === this.backdrop) this.close();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.state.isOpen) this.close();
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

    const clearBtn = this._createButton("×", TEXT.searchClear, () => {
      input.value = "";
      this.state.searchQuery = "";
      this._renderEntries();
      input.focus();
    }, "ghost");
    clearBtn.classList.add("phg-search__clear");

    row.append(createEl("span", "phg-search__icon", "🔍"), input, modeBtn, clearBtn);
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
      this._createButton(useLabel, this.state.target ? "Send prompt to the selected node" : "Copy prompt to clipboard", () => this._handleUse(entry)),
      this._createButton("Copy", "Copy full prompt structure", () => this._copyAllPrompts(entry)),
      this._createButton("Delete", "Delete entry", () => this._deleteEntry(entry), "danger")
    );
    return actions;
  }

  _buildPrompt(text) {
    const container = createEl("div", "phg-entry-card__prompt");
    const pre = createEl("pre");
    pre.textContent = text ?? "";
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
      guard.restores.push(() => { obj[name] = original; });
    };

    const wrapKeyHandler = (obj, name) => {
      wrap(obj, name, function (original, event, ...rest) {
        if (dialog._shouldBlockComfyClipboard(event)) return false;
        return original.call(this, event, ...rest);
      });
    };

    const wrapClipboard = (obj, name) => {
      wrap(obj, name, function (original, ...args) {
        if (dialog._shouldBlockComfyClipboard()) return undefined;
        return original.apply(this, args);
      });
    };

    const comfyApp = this.comfyApp ?? resolveComfyApp();
    const canvas = comfyApp?.canvas ?? null;
    const proto = window.LGraphCanvas?.prototype ?? window.LiteGraph?.LGraphCanvas?.prototype ?? null;

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
      try { restore(); } catch (error) { logError(LOGGER, "comfy shortcut guard restore error", error); }
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
      this.messageTimeout = setTimeout(() => { this.statusEl.textContent = ""; }, 3200);
    }
  }

  _updateTargetLabel() {
    const target = this.state.target;
    this.targetLabel.textContent = target ? TEXT.subtitleTarget(target.nodeTitle) : TEXT.subtitleMissing;
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
      return { entry, sources, imageCount: sources.length };
    });

    const maxImages = preparedEntries.reduce((max, item) => Math.max(max, item.imageCount), 0);
    const highlightEnabled = this.settingsState?.highlightUsage !== false;
    const startCount = clamp(Number(this.settingsState?.highlightUsageStartCount ?? 5), USAGE_START_MIN, USAGE_START_MAX);
    const ratio = clamp(Number(this.settingsState?.highlightUsageRatio ?? 0.8), USAGE_RATIO_MIN, USAGE_RATIO_MAX);
    const fullGlowAt = maxImages > 1 ? Math.max(startCount + 1, Math.round(maxImages * ratio)) : null;

    for (const item of preparedEntries) {
      const highlight = highlightEnabled && maxImages >= startCount && item.imageCount >= startCount;
      const strength = (() => {
        if (!highlight || !maxImages || !fullGlowAt || fullGlowAt <= startCount) return 0;
        const numerator = item.imageCount - startCount;
        const denom = fullGlowAt - startCount;
        if (denom <= 0) return 1;
        return clamp(numerator / denom, 0, 1);
      })();

      this.listEl.appendChild(
        this._renderEntry(item.entry, item.sources, {
          imageCount: item.imageCount, maxImages, highlight,
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
    const terms = query.split(/[\s,]+/).map((term) => term.trim()).filter(Boolean);
    if (!terms.length) return entries;
    const isOrMode = this.state.searchMode === "or";
    return entries.filter((entry) => {
      const combinedText = String(entry.prompt ?? "").toLowerCase() + " " + String(entry.negative_prompt ?? "").toLowerCase();
      const matchesTerm = (term) => combinedText.includes(term);
      return isOrMode ? terms.some(matchesTerm) : terms.every(matchesTerm);
    });
  }

  _renderEntry(entry, sourcesArg = null, usageMeta = {}) {
    const article = createEl("article", "phg-entry-card");
    const sources = Array.isArray(sourcesArg) ? sourcesArg : buildImageSources(entry, this.api);
    const hasImages = sources.length > 0;
    const preview = hasImages ? sources[sources.length - 1] : null; 

    const imageCount = usageMeta.imageCount ?? sources.length;
    const maxImages = usageMeta.maxImages ?? imageCount;
    const highlight = Boolean(usageMeta.highlight);
    const threshold = usageMeta.highlightThreshold;
    const strength = clamp(Number(usageMeta.highlightStrength ?? 0), 0, 1);

    if (highlight) {
      article.classList.add("phg-entry-card--popular");
      article.style.setProperty("--phg-usage-strength", String(strength));
      article.dataset.usageCount = String(imageCount);
      if (maxImages) article.dataset.usageMax = String(maxImages);
      if (threshold) article.dataset.usageThreshold = String(threshold);
    }

    const header = createEl("div", "phg-entry-card__header");
    const stamp = createEl("div", "phg-entry-card__stamp", formatTimestamp(entry?.last_used_at ?? entry?.created_at));
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
    body.append(this._buildPreview(preview, entry, sources), this._buildPromptContainer(entry));
    const metaRow = createEl("div", "phg-entry-card__footer");
    article.append(header, body, metaRow);
    return article;
  }

  _buildPreview(preview, entry, sources) {
    const box = createEl("div", "phg-entry-card__preview");
    if (!preview) {
      box.append(createEl("div", "phg-preview-placeholder", "No image"));
      return box;
    }
    
    // Контейнер для изображения и чекбокса
    const imageContainer = createEl("div", "phg-preview-image-container");
    
    const img = createEl("img");
    img.src = preview.thumb ?? preview.url;
    img.alt = preview.title ?? "Generated image";
    img.loading = "lazy";
    img.addEventListener("click", (event) => {
      event.stopPropagation();
      this._openGallery(entry, sources.length - 1);
    });
    
    imageContainer.append(img);
    box.append(imageContainer);
    
    // Убрали контейнер для информации об изображении (filename и metadata)
    
    return box;
  }

  _extractMetadataSummary(entry) {
    // Метод больше не используется в истории, но оставляем для совместимости
    return "";
  }

  _buildPromptContainer(entry) {
    const container = createEl("div", "phg-prompt-container");
    
    // Функция для создания секции промта с кнопкой Show More
    const createPromptSection = (promptText, label, typeClass) => {
      const section = createEl("div", `phg-prompt-section ${typeClass}`);
      const header = createEl("div", "phg-prompt-header");
      
      const labelEl = createEl("div", "phg-prompt-label", label);
      const copyBtn = this._createIconButton("📋", `Copy ${label.toLowerCase()}`, () => 
        this._copyIndividualPrompt(promptText, label.replace(":", "")));
      
      header.append(labelEl, copyBtn);
      section.append(header);
      
      // Создаем контейнер для текста промта
      const textContainer = createEl("div", "phg-prompt-text-container");
      const preEl = createEl("pre", "phg-prompt-text");
      preEl.textContent = promptText ?? "";
      textContainer.append(preEl);
      section.append(textContainer);
      
      // Проверяем длину промта (более 7 строк или очень длинный текст)
      if (promptText && promptText.length > 0) {
        const lines = promptText.split('\n');
        // Показываем кнопку Show More если:
        // 1. Больше 7 строк ИЛИ
        // 2. Текст длиннее 500 символов (для случаев когда нет переносов строк)
        if (lines.length > 7 || promptText.length > 500) {
          // Добавляем кнопку Show More
          const showMoreBtn = createEl("button", "phg-show-more-btn", "Show More");
          showMoreBtn.addEventListener("click", () => {
            const isExpanded = textContainer.classList.toggle("phg-expanded");
            showMoreBtn.textContent = isExpanded ? "Show Less" : "Show More";
          });
          section.append(showMoreBtn);
          
          // Ограничиваем высоту контейнера
          textContainer.classList.add("phg-collapsed");
        }
      }
      
      return section;
    };
    
    const posContainer = createPromptSection(
      entry.prompt ?? "", 
      "POSITIVE PROMPT:", 
      "phg-prompt-section--positive"
    );
    
    const negContainer = createPromptSection(
      entry.negative_prompt ?? "", 
      "NEGATIVE PROMPT:", 
      "phg-prompt-section--negative"
    );
    
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

    let widget = node.widgets?.find((item) => item?.name === target.widgetName) ?? resolvePromptWidget(node);
    const MAX_TRAVERSAL = 10;
    let traversalCount = 0;

    while (widget && traversalCount < MAX_TRAVERSAL) {
      const input = node.inputs?.find((i) => i.name === widget.name);
      if (input && input.link) {
        const upstreamNode = resolveUpstreamConnection(node, widget.name);
        if (upstreamNode) {
          node = upstreamNode;
          widget = findFirstFreeStringWidget(node);
          traversalCount++;
          if (!widget) break;
        } else break;
      } else break;
    }

    if (!widget) {
      await this._copyPrompt(entry);
      this._setMessage(TEXT.copiedMissingWidget, "warn");
      this.close();
      return;
    }

    const updated = applyPromptToWidget(node, widget, entry.prompt ?? "");
    
    if (entry.negative_prompt && entry.negative_prompt.trim() !== "") {
      let negWidget = findFirstFreeStringWidget(node);
      if (negWidget === widget) {
        const allWidgets = node.widgets?.filter((w) => w.type === "string" || w.type === "customtext") || [];
        const widgetIndex = allWidgets.indexOf(widget);
        if (widgetIndex >= 0 && widgetIndex < allWidgets.length - 1) negWidget = allWidgets[widgetIndex + 1];
        else negWidget = null;
      }
      if (negWidget && negWidget !== widget) applyPromptToWidget(node, negWidget, entry.negative_prompt);
    }
    
    this.state.target = normalizeTargetPayload(node) ?? null;
    this._updateTargetLabel();
    this._setMessage(updated ? TEXT.sent(this.state.target?.nodeTitle) : TEXT.same, updated ? "success" : "muted");
    this.close();
  }

  async _copyPrompt(entry) {
    try {
      await navigator.clipboard.writeText(entry.prompt ?? "");
      this._setMessage(TEXT.copied, "info");
    } catch (error) {
      logError(LOGGER, "copyPrompt error", error);
      this._setMessage("Failed to copy prompt.", "error");
    }
  }

  async _copyIndividualPrompt(text, type) {
    try {
      await navigator.clipboard.writeText(text ?? "");
      this._setMessage(`${type} prompt copied.`, "info");
    } catch (error) {
      logError(LOGGER, "copyIndividualPrompt error", error);
      this._setMessage(`Failed to copy ${type.toLowerCase()} prompt.`, "error");
    }
  }

  async _copyAllPrompts(entry) {
    try {
      const textToCopy = `POSITIVE PROMPT:\n${entry.prompt ?? ""}\n\nNEGATIVE PROMPT:\n${entry.negative_prompt ?? ""}`;
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
    if (sources.length > 1) {
      this._openGallery(entry, sources.length - 1);
      return;
    }
    await this._saveFileFromSource(sources[sources.length - 1], entry);
  }

  async _saveFileFromSource(source, entry) {
    try {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error("Failed to fetch image");
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      // Используем filename из source (из archive), если есть, иначе генерируем из entry.id
      const filename = source.filename || `prompt_${entry.id || Date.now()}.png`;
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

  async saveSelectedImageFromGallery(imageElement) {
    try {
      const src = imageElement.src || imageElement.getAttribute("data-original");
      if (!src) throw new Error("No image source found");
      const response = await fetch(src);
      if (!response.ok) throw new Error("Failed to fetch image");
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      // Используем filename из dataset или data-original-url, если есть
      const filename = imageElement.dataset.filename || `prompt_${imageElement.dataset.entryId || Date.now()}.png`;
      a.download = filename;
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

  // --- НОВЫЙ МЕТОД ДЛЯ ПЕРЕЗАПУСКА ГАЛЕРЕИ ---
  async reopenGalleryForEntry(entryId) {
    // 1. Находим запись в обновленном списке
    const entry = this.state.entries.find(e => e.id === entryId);

    // 2. Сценарий "Удалено всё": Если записи нет, закрываем галлерею и обновим список в диалоге.
    if (!entry) {
        this.viewer.close(); // Закрыть окно просмотра
        this._renderEntries(); // Обновить сам список записей в родительском компоненте (диалог)
        return; 
    }

    // 3. Если запись найдена: Строим источники заново на основе текущего состояния API.
    const sources = buildImageSources(entry, this.api); 
    
    // 4. Сценарий "Удалено все картинки для этой записи": Закрываем галлерею
    if (!sources || sources.length === 0) {
        this.viewer.close();
        this._renderEntries(); // Обновить список записей, чтобы показать пустоту
        return;
    }

    // 5. Если все ок: Открываем галерею с чистыми данными (Citation 3 logic)
    // Сначала закрываем текущий viewer, чтобы сбросить состояние
    this.viewer.close();
    // Даем DOM полностью очиститься перед открытием новой галереи
    setTimeout(() => {
      try {
        this.viewer.open(entryId, sources, 0, this);
      } catch (e) {
        logError(LOGGER, "reopenGallery error", e);
      }
    }, 100);
}

  // --- НОВЫЙ МЕТОД ДЛЯ БЕСШОВНОГО ОБНОВЛЕНИЯ ДАННЫХ ГАЛЕРЕИ ---
  async refreshGalleryData(entryId) {
    // 1. Находим запись в обновленном списке
    let entry = this.state.entries.find(e => e.id === entryId);

    // 2. Сценарий "Удалено всё": Если записи нет, ищем другую запись с изображениями
    if (!entry) {
        console.log('[PHG Dialog] Entry', entryId, 'not found, looking for alternative...');
        // Ищем первую запись с изображениями
        for (const e of this.state.entries) {
            const sources = buildImageSources(e, this.api);
            if (sources && sources.length > 0) {
                entry = e;
                console.log('[PHG Dialog] Found alternative entry:', entry.id);
                break;
            }
        }
        
        // Если так и не нашли ни одной записи с изображениями
        if (!entry) {
            console.log('[PHG Dialog] No entries with images found');
            return null;
        }
    }

    // 3. Строим источники заново на основе текущего состояния API
    let sources = buildImageSources(entry, this.api);
    
    // 4. Сценарий "Удалено все картинки для этой записи": ищем другую запись
    if (!sources || sources.length === 0) {
        console.log('[PHG Dialog] No sources for entry', entry.id, ', looking for alternative...');
        // Ищем другую запись с изображениями
        for (const e of this.state.entries) {
            if (e.id !== entryId) {
                const altSources = buildImageSources(e, this.api);
                if (altSources && altSources.length > 0) {
                    entry = e;
                    sources = altSources;
                    console.log('[PHG Dialog] Found alternative entry:', entry.id);
                    break;
                }
            }
        }
        
        // Если так и не нашли ни одной записи с изображениями
        if (!sources || sources.length === 0) {
            console.log('[PHG Dialog] No entries with images found');
            return null;
        }
    }

    // 5. Возвращаем обновленные данные
    return { entry, sources };
  }
  // -------------------------------------------

 // -------------------------------------------
// ИСПРАВЛЕННЫЙ deleteSelectedImageFromHistory (Финальная версия)
// -------------------------------------------
async deleteSelectedImageFromHistory(entryId, filename, subfolder = "", fileType = "") {
    if (!entryId || !filename) return;

    try {
        // Шаг 1: Вызов API на удаление данных (Backend - Citation 1)
        await this.historyApi.deleteOutputFile(entryId, filename, subfolder, fileType);
        
        // Шаг 2: Принудительное обновление кеша данных во всем компоненте (ВАЖНО!)
        // Это гарантирует, что другие элементы UI знают о том, что данные удалены.
        await this.refresh(); 

        // Шаг 3: Бесшовное обновление галереи с учетом нового состояния
        await this.viewer._refreshGalleryData(entryId); 
        
        this._setMessage("Image deleted from history", "success");

    } catch (error) {
        logError(LOGGER, "delete from history error", error);
        this._setMessage("Failed to delete image from history", "error");
    }
}

  async deleteSelectedImageEverywhere(entryId, filename, subfolder = "", fileType = "") {
    if (!entryId || !filename) return;
    try {
      await this.historyApi.deleteEverywhere(entryId, filename, subfolder, fileType);
      await this.refresh();
      await this.viewer._refreshGalleryData(entryId); // Бесшовное обновление
      this._setMessage("Image and associated files deleted", "success");
    } catch (error) {
      logError(LOGGER, "delete everywhere error", error);
      this._setMessage("Failed to delete image", "error");
    }
  }

  async deleteOthersExceptSelected(entryId, filename, subfolder = "", fileType = "") {
    if (!entryId || !filename) return;
    try {
      await this.historyApi.deleteOthersExcept(entryId, filename, subfolder, fileType);
      await this.refresh();
      await this.viewer._refreshGalleryData(entryId); // Бесшовное обновление
      this._setMessage("Other images deleted", "success");
    } catch (error) {
      logError(LOGGER, "delete others error", error);
      this._setMessage("Failed to delete other images", "error");
    }
  }

  async undoLastAction() {
    try {
      await this.refresh();
      this._setMessage("Gallery refreshed", "success");
    } catch (error) {
      logError(LOGGER, "undo error", error);
      this._setMessage("Failed to undo action", "error");
    }
  }

  async _openGallery(entry, startIndex = 0) {
    const sources = buildImageSources(entry, this.api);
    if (!sources.length) {
      this._setMessage(TEXT.noImages, "warn");
      return;
    }
    try {
      await this.viewer.open(entry.id ?? null, sources, Math.max(0, startIndex), this);
    } catch (error) {
      logError(LOGGER, "openGallery error", error);
      this._setMessage("Failed to open gallery.", "error");
    }
  }

  async _savePrompt(entry) {
    try {
      const promptText = `POSITIVE PROMPT:\n${entry.prompt ?? ""}\n\nNEGATIVE PROMPT:\n${entry.negative_prompt ?? ""}`;
      const blob = new Blob([promptText], { type: "text/plain" });
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `prompt_${entry.id || Date.now()}.txt`;
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

function ensureDialog() {
  if (!dialogInstance) {
    dialogInstance = new HistoryDialog({ api: resolveComfyApi(), comfyApp: resolveComfyApp() });
  }
  return dialogInstance;
}

function attachUpdateListeners(api, eventBus) {
  if (listenersAttached) return;
  const dialog = ensureDialog();
  const handler = (event) => { dialog.refreshIfOpen(); };
  api?.addEventListener?.(HISTORY_UPDATE_EVENT, handler);
  eventBus?.on?.(HISTORY_UPDATE_EVENT, handler);
  listenersAttached = true;
}

function attachHistoryButton(node) {
  if (!node || typeof node.addWidget !== "function") return;
  const existing = Array.isArray(node.widgets)
    ? node.widgets.find((widget) => widget?.[HISTORY_WIDGET_FLAG] === true || widget?.name === HISTORY_WIDGET_LABEL)
    : null;
  const dialog = ensureDialog();
  const handler = () => dialog.openWithNode(node);
  if (existing) {
    existing.callback = handler;
    existing[HISTORY_WIDGET_FLAG] = true;
    existing.name = HISTORY_WIDGET_LABEL;
    return;
  }
  const widget = node.addWidget("button", HISTORY_WIDGET_LABEL, null, handler, { serialize: false });
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