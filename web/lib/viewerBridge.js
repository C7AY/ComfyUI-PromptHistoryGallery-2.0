import { createAssetLoader } from "./assetLoader.js";
import { extractMetadata, formatMetadata } from "./metadata.js";

const DEFAULT_ROOT_ID = "phg-viewer-root";

// Helper function to create the save button
function _createSaveButton(viewer, viewerFooter, dialogInstance) {
  // Create wrapper div for the save button (matching user's example exactly)
  const saveButtonWrapper = document.createElement("div");
  saveButtonWrapper.className = "viewer-SaveSelectedButton";
  saveButtonWrapper.style.cssText = "padding: 10px; text-align: center; display: block; width: 100%;";
  
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "phg-button phg-button--success";
  saveBtn.textContent = "Save Selected Image";
  saveBtn.title = "Save file with dialog";
  saveBtn.onclick = async () => {
    const activeImage = viewer.image;
    if (!activeImage) {
      console.warn("[PHG] No active image to save");
      return;
    }
    
    // Use dialog instance to save if available
    if (dialogInstance && typeof dialogInstance.saveSelectedImageFromGallery === "function") {
      await dialogInstance.saveSelectedImageFromGallery(activeImage);
    } else {
      // Fallback to inline save
      const src = activeImage.src || activeImage.getAttribute("data-original");
      if (!src) {
        console.warn("[PHG] No image source found");
        return;
      }
      
      try {
        const response = await fetch(src);
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        const entryId = activeImage.dataset.entryId || Date.now();
        a.download = `prompt_${entryId}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      } catch (error) {
        console.error("[PHG] Save image error:", error);
      }
    }
  };
  
  saveButtonWrapper.appendChild(saveBtn);
  
  // Find the title element and toolbar
  const viewerTitle = viewerFooter.querySelector(".viewer-title");
  const viewerToolbar = viewerFooter.querySelector(".viewer-toolbar");
  
  // Insert between title and toolbar (exactly as user requested)
  if (viewerTitle && viewerToolbar) {
    viewerTitle.parentNode.insertBefore(saveButtonWrapper, viewerToolbar);
  } else if (viewerToolbar) {
    // If no title, insert before toolbar
    viewerToolbar.parentNode.insertBefore(saveButtonWrapper, viewerToolbar);
  } else {
    // Fallback: append to footer
    viewerFooter.appendChild(saveButtonWrapper);
  }
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
  }

  async ensureAssets() {
    await this.assetLoader.ensureAssets({
      styles: [this.cssUrl],
      scripts: [this.scriptUrl],
    });
    if (typeof window.Viewer !== "function") {
      throw new Error("Viewer.js did not load correctly.");
    }
  }

  ensureRoot() {
    return ensureElement(this.rootId);
  }

  _teardown(fromHidden = false) {
    const cleanup = this.cleanupFn;
    this.cleanupFn = null;
    if (typeof cleanup === "function") {
      cleanup(fromHidden);
      return;
    }

    if (!this.instance) {
      this.activeEntryId = null;
      this._clearRoot();
      return;
    }

    try {
      if (!fromHidden) {
        this.instance.hide?.();
      }
      this.instance.destroy?.();
    } catch (error) {
      console.error("[PromptHistoryGallery]", "Viewer teardown error", error);
    }
    this.instance = null;
    this.activeEntryId = null;
    this._clearRoot();
  }

  _clearRoot() {
    const root = document.getElementById(this.rootId);
    if (root) {
      root.innerHTML = "";
    }
  }

  removeRoot() {
    const root = document.getElementById(this.rootId);
    if (root?.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

  async open(entryId, items, startIndex = 0, entry = null, dialogInstance = null) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("No images available for this entry.");
    }
    await this.ensureAssets();
    this._teardown(false);

    const root = this.ensureRoot();
    root.innerHTML = "";

    const metadataByEntryId =
      entry?.metadata && typeof entry.metadata === "object"
        ? (entry.metadata._phg_entry_metadata ?? null)
        : null;
    const fallbackMetaString = entry ? formatMetadata(extractMetadata(entry)) : "";

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      let metaString = fallbackMetaString;
      if (metadataByEntryId && item?.entryId && metadataByEntryId[item.entryId]) {
        metaString = formatMetadata(extractMetadata({ metadata: metadataByEntryId[item.entryId] }));
      }
      const image = document.createElement("img");
      image.src = item.thumb ?? item.url;
      image.setAttribute("data-original", item.url);
      image.alt = item.title ?? "";
      if (item.title) {
        image.setAttribute("data-caption", item.title);
      }
      if (item?.entryId) {
        image.dataset.entryId = String(item.entryId);
      }
      if (metaString) {
        image.setAttribute("data-meta", metaString);
      }
      image.loading = "lazy";
      image.dataset.index = String(index);
      fragment.appendChild(image);
    });

    root.appendChild(fragment);

    const viewer = new window.Viewer(root, {
      navbar: true,
      toolbar: {
        zoomIn: 1,
        zoomOut: 1,
        oneToOne: 1,
        reset: 1,
        prev: 1,
        play: { show: false },
        next: 1,
        rotateLeft: 1,
        rotateRight: 1,
        flipHorizontal: 1,
        flipVertical: 1,
        download: 0,
      },
      tooltip: true,
      movable: true,
      zoomable: true,
      rotatable: true,
      scalable: true,
      transition: false,
      fullscreen: true,
      keyboard: true,
      inheritedAttributes: [
        "crossOrigin",
        "decoding",
        "isMap",
        "loading",
        "referrerPolicy",
        "sizes",
        "srcset",
        "useMap",
        "data-meta",
      ],
      initialViewIndex: Math.min(Math.max(startIndex || 0, 0), items.length - 1),
      url(image) {
        return image?.getAttribute?.("data-original") || image?.src || "";
      },
      title: function(image) {
        // Возвращаем только текст заголовка - Viewer.js сам создаст элемент
        const caption = image?.getAttribute?.("data-caption") || image?.alt || "";
        const metaString = image?.getAttribute?.("data-meta") || "";
        let titleContent = caption ? caption : "";
        if (metaString) {
          titleContent += ` (${metaString})`;
        }
        return titleContent;
      },
      shown(event) {
        // После показа изображения добавляем кнопку сохранения
        const viewerFooter = event.detail?.viewer?.footer || document.querySelector(".viewer-footer");
        if (!viewerFooter) return;
        
        // Проверяем, есть ли уже наша кнопка
        const existingBtn = viewerFooter.querySelector(".viewer-SaveSelectedButton");
        if (existingBtn) return;
        
        // Создаем обертку для кнопки
        const saveWrapper = document.createElement('div');
        saveWrapper.className = 'viewer-SaveSelectedButton';
        saveWrapper.style.cssText = 'padding: 8px 10px; text-align: center; margin-bottom: 4px; display: block; width: 100%;';
        
        // Создаем кнопку
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'phg-button phg-button--success';
        saveBtn.title = 'Save file with dialog';
        saveBtn.style.cssText = 'pointer-events: auto; cursor: pointer;';
        saveBtn.textContent = 'Save Selected Image';
        
        // Обработчик клика
        saveBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          e.preventDefault();
          
          const activeImage = viewer.image;
          if (!activeImage) {
            console.warn('[PHG] No active image to save');
            return;
          }
          
          if (dialogInstance && typeof dialogInstance.saveSelectedImageFromGallery === 'function') {
            await dialogInstance.saveSelectedImageFromGallery(activeImage);
          } else {
            const src = activeImage.src || activeImage.getAttribute('data-original');
            if (!src) {
              console.warn('[PHG] No image source found');
              return;
            }
            
            try {
              const response = await fetch(src);
              const blob = await response.blob();
              const downloadUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = downloadUrl;
              const entryId = activeImage.dataset.entryId || Date.now();
              a.download = `prompt_${entryId}.png`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(downloadUrl);
            } catch (error) {
              console.error('[PHG] Save image error:', error);
            }
          }
        });
        
        saveWrapper.appendChild(saveBtn);
        
        // Находим заголовок и вставляем кнопку между заголовком и toolbar
        const viewerTitle = viewerFooter.querySelector(".viewer-title");
        const viewerToolbar = viewerFooter.querySelector(".viewer-toolbar");
        
        if (viewerTitle && viewerToolbar) {
          viewerTitle.parentNode.insertBefore(saveWrapper, viewerToolbar);
        } else if (viewerTitle) {
          viewerTitle.parentNode.appendChild(saveWrapper);
        } else if (viewerToolbar) {
          viewerToolbar.parentNode.insertBefore(saveWrapper, viewerToolbar);
        } else {
          viewerFooter.appendChild(saveWrapper);
        }
      },
    });

    const hiddenHandler = () => this._teardown(true);
    viewer.element.addEventListener("hidden", hiddenHandler);

    this.instance = viewer;
    this.activeEntryId = entryId ?? null;
    this.hiddenHandler = hiddenHandler;
    this.cleanupFn = (fromHidden = false) => {
      if (this.instance) {
        this.instance.element.removeEventListener("hidden", hiddenHandler);
      }
      this.hiddenHandler = null;
      this.instance = null;
      this.activeEntryId = null;
      this._clearRoot();
      if (!fromHidden) {
        try {
          viewer.hide?.();
        } catch (error) {
          console.error("[PromptHistoryGallery]", "Viewer hide error", error);
        }
      }
      try {
        viewer.destroy();
      } catch (error) {
        console.error("[PromptHistoryGallery]", "Viewer destroy error", error);
      }
    };

    viewer.show();
  }

  close() {
    this._teardown(false);
  }

  dispose() {
    this._teardown(false);
    this.removeRoot();
  }

  isActive(entryId) {
    return !!this.instance && entryId != null && entryId === this.activeEntryId;
  }
}

export function createViewerBridge(options) {
  return new ViewerBridge(options);
}
