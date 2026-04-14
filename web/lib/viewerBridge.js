import { createAssetLoader } from "./assetLoader.js";
import { extractMetadata, formatMetadata } from "./metadata.js";

const DEFAULT_ROOT_ID = "phg-viewer-root";

function parseImageSrc(src) {
  if (!src) return { filename: "", subfolder: "", type: "output" };
  try {
    const fullUrl = src.startsWith('http') ? src : window.location.origin + src;
    const urlObj = new URL(fullUrl);
    const filename = urlObj.searchParams.get('filename') || "";
    const subfolder = urlObj.searchParams.get('subfolder') || "";
    const type = urlObj.searchParams.get('type') || "output";
    if (filename) return { filename, subfolder, type };
    
    const pathname = urlObj.pathname;
    const segments = pathname.split('/').filter(s => s.length > 0);
    const viewIndex = segments.indexOf('view');
    if (viewIndex !== -1 && viewIndex + 3 < segments.length) {
      return {
        type: segments[viewIndex + 1],
        subfolder: segments[viewIndex + 2],
        filename: segments[viewIndex + 3]
      };
    }
  } catch (e) {
    console.error('[PHG] Error parsing image src:', e);
  }
  return { filename: "", subfolder: "", type: "output" };
}

function ensureElement(id) {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement("div");
    element.id = id;
    element.style.display = "none";
    element.setAttribute("aria-hidden", "true");
    document.body.appendChild(element);
  }
  return element;
}

export class ViewerBridge {
  constructor({ cssUrl, scriptUrl, assetLoader = createAssetLoader(), rootId = DEFAULT_ROOT_ID }) {
    this.assetLoader = assetLoader;
    this.cssUrl = cssUrl;
    this.scriptUrl = scriptUrl;
    this.rootId = rootId;
    this.instance = null;
    this.activeEntryId = null;
    this.cleanupFn = null;
    this.hiddenHandler = null;
    this.dialogInstance = null;
  }

  async ensureAssets() {
    await this.assetLoader.ensureAssets({ styles: [this.cssUrl], scripts: [this.scriptUrl] });
    if (typeof window.Viewer !== "function") throw new Error("Viewer.js did not load correctly.");
  }

  ensureRoot() { return ensureElement(this.rootId); }

  _teardown(fromHidden = false) {
    const cleanup = this.cleanupFn;
    this.cleanupFn = null;
    if (typeof cleanup === "function") { cleanup(fromHidden); return; }

    if (!this.instance) {
      this.activeEntryId = null;
      this._clearRoot();
      return;
    }

    try {
      if (!fromHidden) this.instance.hide?.();
      this.instance.destroy?.();
    } catch (error) {
      console.error("[PromptHistoryGallery]", "Viewer teardown error", error);
    }
    this.instance = null;
    this.activeEntryId = null;
    this.dialogInstance = null;
    this._clearRoot();
  }

  _clearRoot() {
    const root = document.getElementById(this.rootId);
    if (root) root.innerHTML = "";
  }

  removeRoot() {
    const root = document.getElementById(this.rootId);
    if (root?.parentNode) root.parentNode.removeChild(root);
  }

  async open(entryId, items, startIndex = 0, entry = null, dialogInstance = null) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("No images available for this entry.");
    
    this.activeEntryId = entryId ?? null;
    this.dialogInstance = dialogInstance;
    console.log(`[PHG] Opening gallery for Entry ID: ${this.activeEntryId}`);

    await this.ensureAssets();
    this._teardown(false);

    const root = this.ensureRoot();
    root.innerHTML = "";

    const metadataByEntryId = entry?.metadata && typeof entry.metadata === "object" ? (entry.metadata._phg_entry_metadata ?? null) : null;
    const fallbackMetaString = entry ? formatMetadata(extractMetadata(entry)) : "";

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      let metaString = fallbackMetaString;
      // Приоритет 1: метаданные напрямую из item.metadata (теперь они там есть из БД)
      if (item?.metadata && typeof item.metadata === "object") {
        metaString = formatMetadata(extractMetadata({ metadata: item.metadata }));
      }
      // Приоритет 2: метаданные через _phg_entry_metadata (старый способ для совместимости)
      else if (metadataByEntryId && item?.entryId && metadataByEntryId[item.entryId]) {
        metaString = formatMetadata(extractMetadata({ metadata: metadataByEntryId[item.entryId] }));
      }
      const image = document.createElement("img");
      image.src = item.thumb ?? item.url;
      image.setAttribute("data-original", item.url);
      image.alt = item.title ?? "";
      if (item.title) image.setAttribute("data-caption", item.title);
      
      const imgEntryId = item.entryId ?? this.activeEntryId;
      if (imgEntryId) image.dataset.entryId = String(imgEntryId);
      if (metaString) image.setAttribute("data-meta", metaString);
      image.loading = "lazy";
      image.dataset.index = String(index);
      fragment.appendChild(image);
    });

    root.appendChild(fragment);

    const viewer = new window.Viewer(root, {
      navbar: true,
      toolbar: {
        zoomIn: 1, zoomOut: 1, oneToOne: 1, reset: 1, prev: 1,
        play: { show: false }, next: 1, rotateLeft: 1, rotateRight: 1,
        flipHorizontal: 1, flipVertical: 1, download: 0,
      },
      tooltip: true, movable: true, zoomable: true, rotatable: true, scalable: true,
      transition: false, fullscreen: true, keyboard: true,
      inheritedAttributes: ["crossOrigin", "decoding", "isMap", "loading", "referrerPolicy", "sizes", "srcset", "useMap", "data-meta", "data-entry-id"],
      initialViewIndex: Math.min(Math.max(startIndex || 0, 0), items.length - 1),
      url(image) { return image?.getAttribute?.("data-original") || image?.src || ""; },
      title: function(image) {
        const caption = image?.getAttribute?.("data-caption") || image?.alt || "";
        const metaString = image?.getAttribute?.("data-meta") || "";
        let titleContent = caption ? caption : "";
        if (metaString) titleContent += ` (${metaString})`;
        return titleContent;
      },
      shown: async (event) => {
        const viewerFooter = event.detail?.viewer?.footer || document.querySelector(".viewer-footer");
        if (!viewerFooter) return;
        
        const existingBtns = viewerFooter.querySelector(".viewer-GalleryButtons");
        if (existingBtns) return;
        
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'viewer-GalleryButtons';
        buttonContainer.style.cssText = 'padding: 5px; text-align: center; display: block; width: 100%;';
        
        // ROW 1: Save
        const row1 = document.createElement('div');
        row1.style.cssText = 'display: flex; justify-content: center; gap: 8px; margin-bottom: 4px;';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'phg-button phg-button--success';
        saveBtn.title = 'Save file with dialog';
        saveBtn.textContent = 'Save Selected Image';
        saveBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); e.preventDefault();
          const activeImage = viewer.image;
          if (!activeImage) return;
          if (this.dialogInstance && typeof this.dialogInstance.saveSelectedImageFromGallery === 'function') {
            await this.dialogInstance.saveSelectedImageFromGallery(activeImage);
          } else {
            const src = activeImage.src || activeImage.getAttribute('data-original');
            if (!src) return;
            try {
              const response = await fetch(src);
              const blob = await response.blob();
              const downloadUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = downloadUrl;
              a.download = `prompt_${activeImage.dataset.entryId || Date.now()}.png`;
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              URL.revokeObjectURL(downloadUrl);
            } catch (error) { console.error('[PHG] Save image error:', error); }
          }
        });
        row1.appendChild(saveBtn);
        buttonContainer.appendChild(row1);
        
        // ROW 2: Delete Buttons
        const row2 = document.createElement('div');
        row2.style.cssText = 'display: flex; justify-content: center; gap: 8px; margin-bottom: 4px;';
        
        // Delete from History
        const deleteHistoryBtn = document.createElement('button');
        deleteHistoryBtn.type = 'button';
        deleteHistoryBtn.className = 'phg-button phg-button--danger';
        deleteHistoryBtn.title = 'Remove image from gallery and history (keep files)';
        deleteHistoryBtn.textContent = 'Delete Selected Image from History';
        deleteHistoryBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); e.preventDefault();
          const activeImage = viewer.image;
          if (!activeImage) { alert("No image selected"); return; }
          
          let currentEntryId = activeImage.dataset.entryId;
          if (!currentEntryId && this.activeEntryId) currentEntryId = this.activeEntryId;

          const src = activeImage.getAttribute('data-original') || activeImage.src;
          const parsed = parseImageSrc(src);
          const { filename, subfolder, type: imgType } = parsed;

          if (!currentEntryId || !filename) { alert("Error: Missing image information."); return; }
          
          if (!window.confirm(`Delete this image from History?\nFile: ${filename}\nThe file will remain on disk.`)) return;
          
          try {
            const response = await fetch('/phg/delete_image_from_history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entry_id: currentEntryId, filename, subfolder, type: imgType })
            });
            const result = await response.json();
            if (result.success) {
              // ЛОГИКА ОБНОВЛЕНИЯ: Вызываем метод диалога
              if (this.dialogInstance) {
                await this.dialogInstance.reopenGalleryForEntry(currentEntryId);
              } else {
                viewer.close();
              }
            } else {
              alert('Failed to delete: ' + (result.error || 'Unknown error'));
            }
          } catch (error) {
            console.error('[PHG] Delete request failed', error);
            alert('Error deleting image: ' + error.message);
          }
        });
        
        // Delete Everywhere
        const deleteEverywhereBtn = document.createElement('button');
        deleteEverywhereBtn.type = 'button';
        deleteEverywhereBtn.className = 'phg-button phg-button--danger';
        deleteEverywhereBtn.title = 'Remove image and delete files from archive';
        deleteEverywhereBtn.textContent = 'Delete Selected Image Everywhere';
        deleteEverywhereBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); e.preventDefault();
          const activeImage = viewer.image;
          if (!activeImage) { alert("No image selected"); return; }
          
          let currentEntryId = activeImage.dataset.entryId;
          if (!currentEntryId && this.activeEntryId) currentEntryId = this.activeEntryId;

          const src = activeImage.getAttribute('data-original') || activeImage.src;
          const parsed = parseImageSrc(src);
          const { filename, subfolder, type: imgType } = parsed;

          if (!currentEntryId || !filename) { alert("Error: Missing image information."); return; }

          if (!window.confirm(`Delete this image everywhere?\nFile: ${filename}\n\nThis will:\n- Remove from history database\n- Delete archived image file\n- Delete archived prompt file (if exists)\n\nThis action cannot be undone!`)) return;

          try {
            const response = await fetch('/phg/delete_image_everywhere', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ entry_id: currentEntryId, filename, subfolder, type: imgType })
            });
            const result = await response.json();
            if (result.success) {
              // ЛОГИКА ОБНОВЛЕНИЯ: Вызываем метод диалога
              if (this.dialogInstance) {
                await this.dialogInstance.reopenGalleryForEntry(currentEntryId);
              } else {
                viewer.close();
              }
            } else {
              alert('Failed to delete: ' + (result.error || 'Unknown error'));
            }
          } catch (error) {
            console.error('[PHG] Delete-everywhere request failed', error);
            alert('Error deleting image: ' + error.message);
          }
        });
        
        row2.appendChild(deleteHistoryBtn);
        row2.appendChild(deleteEverywhereBtn);
        buttonContainer.appendChild(row2);
        
        // ROW 3: Delete Others
        const row3 = document.createElement('div');
        row3.style.cssText = 'display: flex; justify-content: center; gap: 8px;';
        
        const deleteOthersBtn = document.createElement('button');
        deleteOthersBtn.type = 'button';
        deleteOthersBtn.className = 'phg-button phg-button--purple';
        deleteOthersBtn.title = 'Delete all other images in this batch except the selected one';
        deleteOthersBtn.textContent = 'Delete Others Except The Selected';
        deleteOthersBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); e.preventDefault();
          const activeImage = viewer.image;
          if (!activeImage) { alert("No image selected"); return; }
          
          let currentEntryId = activeImage.dataset.entryId;
          if (!currentEntryId && this.activeEntryId) currentEntryId = this.activeEntryId;
          if (!currentEntryId) { alert("Error: Could not determine Entry ID."); return; }

          const allImages = root.querySelectorAll('img');
          const imagesToDelete = [];
          const activeSrc = activeImage.getAttribute('data-original') || activeImage.src;
          const activeParsed = parseImageSrc(activeSrc);
          
          allImages.forEach(img => {
            const imgSrc = img.getAttribute('data-original') || img.src;
            const parsed = parseImageSrc(imgSrc);
            if (parsed.filename && parsed.filename !== activeParsed.filename) {
              imagesToDelete.push({ filename: parsed.filename, subfolder: parsed.subfolder, type: parsed.type });
            }
          });
          
          if (imagesToDelete.length === 0) { alert("No other images found in this batch to delete."); return; }
          
          if (!window.confirm(`Delete ${imagesToDelete.length} other image(s)?\n\nOnly the currently selected image will remain.\nAll others will be deleted from disk and database.\n\nThis action cannot be undone!`)) return;
          
          try {
            const response = await fetch('/phg/delete_others_except_selected', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                entry_id: currentEntryId,
                keep_filename: activeParsed.filename,
                keep_subfolder: activeParsed.subfolder,
                keep_type: activeParsed.type,
                files_to_delete: imagesToDelete
              })
            });
            const result = await response.json();
            if (result.success) {
              // ЛОГИКА ОБНОВЛЕНИЯ: Вызываем метод диалога
              if (this.dialogInstance) {
                await this.dialogInstance.reopenGalleryForEntry(currentEntryId);
              } else {
                viewer.close();
              }
            } else {
              alert('Failed to delete: ' + (result.error || 'Unknown error'));
            }
          } catch (error) {
            console.error('[PHG] Delete-others request failed', error);
            alert('Error deleting images: ' + error.message);
          }
        });
        
        const undoBtn = document.createElement('button');
        undoBtn.type = 'button';
        undoBtn.className = 'phg-button phg-button--blue';
        undoBtn.title = 'Undo last delete action';
        undoBtn.textContent = 'Undo';
        undoBtn.addEventListener('click', async (e) => {
          e.stopPropagation(); e.preventDefault();
          alert("Functionality 'Undo' is coming soon.");
        });
        
        row3.appendChild(deleteOthersBtn);
        row3.appendChild(undoBtn);
        buttonContainer.appendChild(row3);
        
        const viewerTitle = viewerFooter.querySelector(".viewer-title");
        const viewerToolbar = viewerFooter.querySelector(".viewer-toolbar");
        if (viewerTitle && viewerToolbar) viewerTitle.parentNode.insertBefore(buttonContainer, viewerToolbar);
        else if (viewerTitle) viewerTitle.parentNode.appendChild(buttonContainer);
        else if (viewerToolbar) viewerToolbar.parentNode.insertBefore(buttonContainer, viewerToolbar);
        else viewerFooter.appendChild(buttonContainer);
      },
    });

    const hiddenHandler = () => this._teardown(true);
    viewer.element.addEventListener("hidden", hiddenHandler);

    this.instance = viewer;
    this.activeEntryId = entryId ?? null;
    this.hiddenHandler = hiddenHandler;
    this.cleanupFn = (fromHidden = false) => {
      if (this.instance) this.instance.element.removeEventListener("hidden", hiddenHandler);
      this.hiddenHandler = null;
      this.instance = null;
      this.activeEntryId = null;
      this.dialogInstance = null;
      this._clearRoot();
      if (!fromHidden) { try { viewer.hide?.(); } catch (error) { console.error("[PromptHistoryGallery]", "Viewer hide error", error); } }
      try { viewer.destroy(); } catch (error) { console.error("[PromptHistoryGallery]", "Viewer destroy error", error); }
    };

    viewer.show();
  }

  close() { this._teardown(false); }
  dispose() { this._teardown(false); this.removeRoot(); }
  isActive(entryId) { return !!this.instance && entryId != null && entryId === this.activeEntryId; }
}

export function createViewerBridge(options) {
  return new ViewerBridge(options);
}