/**
 * Custom Image Viewer for Prompt History Gallery
 * Replaces viewerjs with a lightweight custom implementation
 */

const DEFAULT_OPTIONS = {
  zIndex: 2147483700,
  toolbarSize: 60,
  thumbnailHeight: 100,
  minZoom: 0.1,
  maxZoom: 10,
  zoomStep: 0.5,
};

export class CustomViewer {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.isOpen = false;
    this.images = [];
    this.currentIndex = 0;
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.selectedIndices = new Set();
    this.dialogInstance = null;
    this.activeEntryId = null;
    
    this.container = null;
    this.overlay = null;
    this.viewerContent = null;
    this.imageContainer = null;
    this.currentImage = null;
    this.thumbnailStrip = null;
    this.toolbar = null;
    
    this.keydownHandler = null;
    this.wheelHandler = null;
  }

  open(entryId, items, startIndex = 0, dialogInstance = null) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("No images available for this entry.");
    }

    this.activeEntryId = entryId ?? null;
    this.dialogInstance = dialogInstance;
    this.images = items.map((item, index) => ({
      ...item,
      index,
      entryId: item.entryId ?? entryId,
    }));
    this.currentIndex = Math.min(Math.max(startIndex || 0, 0), items.length - 1);
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.selectedIndices.clear();

    console.log(`[PHG CustomViewer] Opening gallery for Entry ID: ${this.activeEntryId}`);

    this._createDOM();
    this._renderCurrentImage();
    this._renderThumbnails();
    this._renderToolbar();
    this._attachEventListeners();
    
    this.isOpen = true;
  }

  close() {
    if (!this.isOpen) return;
    
    this._detachEventListeners();
    
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    
    this.container = null;
    this.overlay = null;
    this.viewerContent = null;
    this.imageContainer = null;
    this.currentImage = null;
    this.thumbnailStrip = null;
    this.toolbar = null;
    
    this.isOpen = false;
    this.images = [];
    this.currentIndex = 0;
    this.selectedIndices.clear();
  }

  _createDOM() {
    // Remove existing if any
    const existing = document.getElementById('phg-custom-viewer-container');
    if (existing) existing.remove();

    // Main container
    this.container = document.createElement('div');
    this.container.id = 'phg-custom-viewer-container';
    this.container.className = 'phg-custom-viewer-container';
    this.container.style.zIndex = String(this.options.zIndex);

    // Overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'phg-viewer-overlay';
    this.container.appendChild(this.overlay);

    // Viewer content
    this.viewerContent = document.createElement('div');
    this.viewerContent.className = 'phg-viewer-content';
    this.container.appendChild(this.viewerContent);

    // Close button (top right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'phg-viewer-close-btn';
    closeBtn.innerHTML = '<span class="pi pi-times"></span>';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.close());
    this.viewerContent.appendChild(closeBtn);

    // Navigation arrows
    const prevBtn = document.createElement('button');
    prevBtn.className = 'phg-viewer-nav-btn phg-viewer-nav-btn--prev';
    prevBtn.innerHTML = '<span class="pi pi-chevron-left"></span>';
    prevBtn.title = 'Previous (←)';
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.prev();
    });
    this.viewerContent.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'phg-viewer-nav-btn phg-viewer-nav-btn--next';
    nextBtn.innerHTML = '<span class="pi pi-chevron-right"></span>';
    nextBtn.title = 'Next (→)';
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.next();
    });
    this.viewerContent.appendChild(nextBtn);

    // Image container
    this.imageContainer = document.createElement('div');
    this.imageContainer.className = 'phg-viewer-image-container';
    this.imageContainer.addEventListener('mousedown', (e) => this._onDragStart(e));
    this.imageContainer.addEventListener('touchstart', (e) => this._onDragStart(e), { passive: false });
    this.viewerContent.appendChild(this.imageContainer);

    // Info container (for filename and metadata above toolbar)
    this.infoContainer = document.createElement('div');
    this.infoContainer.className = 'phg-viewer-info-container';
    this.viewerContent.appendChild(this.infoContainer);

    // Toolbar
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'phg-viewer-toolbar';
    this.viewerContent.appendChild(this.toolbar);

    // Thumbnail strip
    this.thumbnailStrip = document.createElement('div');
    this.thumbnailStrip.className = 'phg-viewer-thumbnails';
    this.viewerContent.appendChild(this.thumbnailStrip);

    document.body.appendChild(this.container);
  }

  _renderCurrentImage() {
    if (!this.imageContainer || !this.images[this.currentIndex]) return;

    this.imageContainer.innerHTML = '';
    
    const item = this.images[this.currentIndex];
    this.currentImage = document.createElement('img');
    this.currentImage.src = item.url || item.thumb;
    this.currentImage.alt = item.title || '';
    this.currentImage.className = 'phg-viewer-image';
    this.currentImage.draggable = false;
    
    // Store metadata - use item properties directly as they now contain all needed data
    this.currentImage.dataset.index = String(this.currentIndex);
    this.currentImage.dataset.entryId = String(item.entryId || '');
    this.currentImage.dataset.filename = item.filename || '';
    this.currentImage.dataset.subfolder = item.subfolder || '';
    this.currentImage.dataset.type = item.type || 'output';
    
    console.log(`[PHG CustomViewer] Rendering image: ${item.filename}, entryId: ${item.entryId}`);
    
    this._applyTransform();
    this.imageContainer.appendChild(this.currentImage);
    
    // Render info (filename and metadata) above toolbar
    this._renderInfo(item);
  }

  _renderThumbnails() {
    if (!this.thumbnailStrip) return;
    
    this.thumbnailStrip.innerHTML = '';
    
    console.log(`[PHG CustomViewer] Rendering ${this.images.length} thumbnails`);
    
    this.images.forEach((item, index) => {
      const thumbWrapper = document.createElement('div');
      thumbWrapper.className = 'phg-viewer-thumb-wrapper';
      if (index === this.currentIndex) {
        thumbWrapper.classList.add('active');
      }
      
      // Checkbox FIRST (above the image)
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'phg-viewer-thumb-checkbox';
      checkbox.checked = this.selectedIndices.has(index);
      checkbox.title = 'Select for batch action';
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          this.selectedIndices.add(index);
        } else {
          this.selectedIndices.delete(index);
        }
        console.log(`[PHG CustomViewer] Checkbox changed for index ${index}, selected count: ${this.selectedIndices.size}`);
        // Update Delete Selected button state
        this._updateDeleteSelectedButton();
        
        // ПРИ КЛИКЕ НА ЧЕКБОКС - ДЕЛАЕМ ЭТО ИЗОБРАЖЕНИЕ АКТИВНЫМ
        this.goToIndex(index);
      });
      
      thumbWrapper.appendChild(checkbox);
      
      // Thumbnail image AFTER checkbox (so it appears below)
      const thumb = document.createElement('img');
      thumb.src = item.thumb || item.url;
      thumb.alt = item.title || '';
      thumb.className = 'phg-viewer-thumb';
      thumb.addEventListener('click', () => this.goToIndex(index));
      
      thumbWrapper.appendChild(thumb);
      this.thumbnailStrip.appendChild(thumbWrapper);
    });
    
    // Scroll to active thumbnail
    const activeThumb = this.thumbnailStrip.querySelector('.phg-viewer-thumb-wrapper.active');
    if (activeThumb) {
      activeThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }
  
  _updateDeleteSelectedButton() {
    if (!this.toolbar) return;
    const deleteHistoryBtn = this.toolbar.querySelector('[data-action="delete-selected-history"]');
    const deleteEverywhereBtn = this.toolbar.querySelector('[data-action="delete-selected-everywhere"]');
    const hasSelection = this.selectedIndices.size > 0;
    if (deleteHistoryBtn) {
      deleteHistoryBtn.disabled = !hasSelection;
    }
    if (deleteEverywhereBtn) {
      deleteEverywhereBtn.disabled = !hasSelection;
    }
  }

  _renderToolbar() {
    if (!this.toolbar) return;
    
    this.toolbar.innerHTML = '';
    
    // Create button rows container
    const buttonRows = document.createElement('div');
    buttonRows.className = 'phg-viewer-button-rows';
    
    // Row 1: Zoom controls (only -, +, reset) and Save Image
    const row1 = document.createElement('div');
    row1.className = 'phg-viewer-button-row';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'phg-button phg-button--icon phg-button--success';
    saveBtn.innerHTML = '<span class="pi pi-download"></span>';
    saveBtn.title = 'Save Image';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._handleSave();
    });
    row1.appendChild(saveBtn);
    
    const zoomOutBtn = document.createElement('button');
    zoomOutBtn.className = 'phg-button phg-button--icon';
    zoomOutBtn.innerHTML = '<span class="pi pi-minus"></span>';
    zoomOutBtn.title = 'Zoom Out (-)';
    zoomOutBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.zoomOut();
    });
    row1.appendChild(zoomOutBtn);
    
    const zoomInBtn = document.createElement('button');
    zoomInBtn.className = 'phg-button phg-button--icon';
    zoomInBtn.innerHTML = '<span class="pi pi-plus"></span>';
    zoomInBtn.title = 'Zoom In (+)';
    zoomInBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.zoomIn();
    });
    row1.appendChild(zoomInBtn);
    
    const resetBtn = document.createElement('button');
    resetBtn.className = 'phg-button phg-button--icon';
    resetBtn.innerHTML = '<span class="pi pi-refresh"></span>';
    resetBtn.title = 'Reset Zoom (0)';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.resetZoom();
    });
    row1.appendChild(resetBtn);
    
    buttonRows.appendChild(row1);
    
    // Row 2: Undo button (commented out for now)
    // const row2 = document.createElement('div');
    // row2.className = 'phg-viewer-button-row phg-viewer-action-row';
    
    // const undoBtn = document.createElement('button');
    // undoBtn.className = 'phg-button phg-button--purple';
    // undoBtn.textContent = 'Undo Delete';
    // undoBtn.title = 'Restore last deleted image from backup';
    // undoBtn.addEventListener('click', async (e) => {
    //   e.stopPropagation();
    //   await this._handleUndoDelete();
    // });
    // row2.appendChild(undoBtn);
    
    // buttonRows.appendChild(row2);
    
    // Row 3: Delete buttons (only 2 simplified buttons)
    const row3 = document.createElement('div');
    row3.className = 'phg-viewer-button-row phg-viewer-action-row';
    
    const deleteHistoryBtn = document.createElement('button');
    deleteHistoryBtn.className = 'phg-button phg-button--danger';
    deleteHistoryBtn.setAttribute('data-action', 'delete-selected-history');
    deleteHistoryBtn.textContent = 'Delete Selected From History';
    deleteHistoryBtn.title = 'Remove selected images from gallery only (keep files on disk)';
    deleteHistoryBtn.disabled = this.selectedIndices.size === 0;
    deleteHistoryBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._handleDeleteSelectedFromHistory();
    });
    row3.appendChild(deleteHistoryBtn);
    
    const deleteEverywhereBtn = document.createElement('button');
    deleteEverywhereBtn.className = 'phg-button phg-button--danger';
    deleteEverywhereBtn.setAttribute('data-action', 'delete-selected-everywhere');
    deleteEverywhereBtn.textContent = 'Delete Selected Everywhere';
    deleteEverywhereBtn.title = 'Remove selected images from gallery and delete files from disk';
    deleteEverywhereBtn.disabled = this.selectedIndices.size === 0;
    deleteEverywhereBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this._handleDeleteSelectedEverywhere();
    });
    row3.appendChild(deleteEverywhereBtn);
    
    buttonRows.appendChild(row3);
    
    this.toolbar.appendChild(buttonRows);
  }

  _attachEventListeners() {
    // Keyboard shortcuts
    this.keydownHandler = (e) => this._onKeydown(e);
    document.addEventListener('keydown', this.keydownHandler);
    
    // Wheel zoom
    this.wheelHandler = (e) => this._onWheel(e);
    if (this.imageContainer) {
      this.imageContainer.addEventListener('wheel', this.wheelHandler, { passive: false });
    }
    
    // Close on overlay click
    if (this.overlay) {
      this.overlay.addEventListener('click', () => this.close());
    }
    
    // Mouse up for drag
    document.addEventListener('mouseup', () => this._onDragEnd());
    document.addEventListener('touchend', () => this._onDragEnd());
    
    // Mouse/touch move for drag
    this.dragMoveHandler = (e) => this._onDragMove(e);
    document.addEventListener('mousemove', this.dragMoveHandler);
    document.addEventListener('touchmove', this.dragMoveHandler, { passive: false });
  }

  _detachEventListeners() {
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
    }
    if (this.wheelHandler && this.imageContainer) {
      this.imageContainer.removeEventListener('wheel', this.wheelHandler);
    }
    if (this.overlay) {
      this.overlay.removeEventListener('click', () => this.close());
    }
    document.removeEventListener('mouseup', () => this._onDragEnd());
    document.removeEventListener('touchend', () => this._onDragEnd());
    if (this.dragMoveHandler) {
      document.removeEventListener('mousemove', this.dragMoveHandler);
      document.removeEventListener('touchmove', this.dragMoveHandler);
    }
  }

  _onKeydown(e) {
    if (!this.isOpen) return;
    
    // Block ArrowLeft/ArrowRight from propagating to ComfyUI when gallery is open
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
    }
    
    switch (e.key) {
      case 'Escape':
        this.close();
        break;
      case 'ArrowLeft':
        this.prev();
        break;
      case 'ArrowRight':
        this.next();
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomIn();
        break;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomOut();
        break;
      case '0':
        e.preventDefault();
        this.resetZoom();
        break;
      case ' ':
        e.preventDefault();
        this.toggleCurrentSelection();
        break;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.deltaY < 0) {
      this.zoomIn();
    } else {
      this.zoomOut();
    }
  }

  _onDragStart(e) {
    if (e.button !== 0 && e.type === 'mousedown') return;
    
    this.isDragging = true;
    this.startX = (e.clientX || e.touches?.[0]?.clientX || 0) - this.translateX;
    this.startY = (e.clientY || e.touches?.[0]?.clientY || 0) - this.translateY;
    
    if (e.type === 'touchstart') {
      e.preventDefault();
    }
  }

  _onDragMove(e) {
    if (!this.isDragging) return;
    
    const clientX = e.clientX || e.touches?.[0]?.clientX || 0;
    const clientY = e.clientY || e.touches?.[0]?.clientY || 0;
    
    this.translateX = clientX - this.startX;
    this.translateY = clientY - this.startY;
    
    this._applyTransform();
    
    if (e.type === 'touchmove') {
      e.preventDefault();
    }
  }

  _onDragEnd() {
    this.isDragging = false;
  }

  _applyTransform() {
    if (!this.currentImage) return;
    
    this.currentImage.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }

  // Navigation methods
  prev() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this._renderCurrentImage();
      this._renderThumbnails();
    }
  }

  next() {
    if (this.currentIndex < this.images.length - 1) {
      this.currentIndex++;
      this._renderCurrentImage();
      this._renderThumbnails();
    }
  }

  goToIndex(index) {
    if (index >= 0 && index < this.images.length) {
      this.currentIndex = index;
      this._renderCurrentImage();
      this._renderThumbnails();
    }
  }

  _renderInfo(item) {
    if (!this.infoContainer) return;
    
    this.infoContainer.innerHTML = '';
    
    // Filename (centered)
    const filenameEl = document.createElement('div');
    filenameEl.className = 'phg-viewer-filename';
    filenameEl.textContent = item.filename || item.title || 'image.png';
    filenameEl.title = item.filename || item.title || '';
    
    // Metadata container - now with clickable badge buttons
    const metadataContainerEl = document.createElement('div');
    metadataContainerEl.className = 'phg-viewer-metadata-container';
    const metadataBadges = this._extractMetadataBadges(item);
    
    if (metadataBadges.length > 0) {
      metadataBadges.forEach(badge => {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'phg-metadata-badge';
        // Отображаем полный текст бейджа (до 75 символов)
        const badgeText = `${badge.label}: ${badge.value}`;
        badgeEl.textContent = badgeText;
        badgeEl.title = `Click to copy ${badge.label}: ${badge.value}`;
        badgeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this._copyToClipboard(String(badge.value), `${badge.label} copied!`);
        });
        metadataContainerEl.appendChild(badgeEl);
      });
    } else {
      const emptyEl = document.createElement('span');
      emptyEl.className = 'phg-metadata-empty';
      emptyEl.textContent = 'No metadata';
      metadataContainerEl.appendChild(emptyEl);
    }
    
    this.infoContainer.appendChild(filenameEl);
    this.infoContainer.appendChild(metadataContainerEl);
  }

  _extractMetadataBadges(item) {
    // Извлекаем параметры из metadata как массив объектов {label, value}
    const meta = item.metadata || item.meta || {};
    if (!meta || typeof meta !== "object") return [];
    
    const badges = [];
    
    // Пытаемся найти основные параметры генерации
    if (meta.steps) badges.push({ label: 'Steps', value: meta.steps });
    if (meta.cfg) badges.push({ label: 'CFG', value: meta.cfg });
    if (meta.sampler_name) badges.push({ label: 'Sampler', value: meta.sampler_name });
    if (meta.scheduler) badges.push({ label: 'Scheduler', value: meta.scheduler });
    if (meta.seed) badges.push({ label: 'Seed', value: meta.seed });
    if (meta.width && meta.height) badges.push({ label: 'Resolution', value: `${meta.width}x${meta.height}` });
    
    // Flux-specific parameters
    if (meta.flux_guidance) badges.push({ label: 'Flux Guidance', value: meta.flux_guidance });
    if (meta.flux_max_shift) badges.push({ label: 'Max Shift', value: meta.flux_max_shift });
    if (meta.flux_base_shift) badges.push({ label: 'Base Shift', value: meta.flux_base_shift });
    if (meta.aura_shift) badges.push({ label: 'Shift', value: meta.aura_shift });
    
    // CFG Normalization
    if (meta.cfg_norm_strength) badges.push({ label: 'CFG Norm', value: meta.cfg_norm_strength });
    
    // Denoise
    if (meta.denoise) badges.push({ label: 'Denoise', value: meta.denoise });
    
    // ETA
    if (meta.eta) badges.push({ label: 'ETA', value: meta.eta });
    
    // Если есть model_name или checkpoint
    if (meta.model_name || meta.checkpoint) {
      const modelName = meta.model_name || meta.checkpoint;
      // Сокращаем длинное имя модели
      const shortName = modelName.length > 150 ? modelName.substring(0, 147) + "..." : modelName;
      badges.push({ label: 'Model', value: shortName });
    }
    
    // CLIP models
    if (meta.clip_name) {
      const clipName = meta.clip_name;
      const shortClip = clipName.length > 150 ? clipName.substring(0, 147) + "..." : clipName;
      badges.push({ label: 'CLIP', value: shortClip });
    }
    
    // VAE
    if (meta.vae_name) {
      badges.push({ label: 'VAE', value: meta.vae_name });
    }
    
    // LoRA models
    if (meta.loras && Array.isArray(meta.loras) && meta.loras.length > 0) {
      const loraNames = meta.loras.map(l => {
        const strengthStr = l.strength !== undefined && l.strength !== 1.0 ? `:${l.strength}` : '';
        return `${l.name}${strengthStr}`;
      }).join(', ');
      const shortLora = loraNames.length > 150 ? loraNames.substring(0, 147) + "..." : loraNames;
      badges.push({ label: 'LoRA', value: shortLora });
    }
    
    // ControlNets
    if (meta.controlnets && Array.isArray(meta.controlnets) && meta.controlnets.length > 0) {
      const cnNames = meta.controlnets.join(', ');
      const shortCn = cnNames.length > 150 ? cnNames.substring(0, 147) + "..." : cnNames;
      badges.push({ label: 'ControlNet', value: shortCn });
    }
    
    // Upscale models
    if (meta.upscale_models && Array.isArray(meta.upscale_models) && meta.upscale_models.length > 0) {
      const upNames = meta.upscale_models.join(', ');
      const shortUp = upNames.length > 150 ? upNames.substring(0, 147) + "..." : upNames;
      badges.push({ label: 'Upscale', value: shortUp });
    }
    
    return badges;
  }

  async _copyToClipboard(text, message = 'Copied!') {
    try {
      await navigator.clipboard.writeText(text);
      if (this.dialogInstance) {
        this.dialogInstance._setMessage(message, 'success');
      } else {
        console.log(`[PHG] ${message}`);
      }
    } catch (err) {
      console.error('[PHG] Failed to copy:', err);
    }
  }

  // Zoom methods
  zoomIn() {
    this.scale = Math.min(this.scale + this.options.zoomStep, this.options.maxZoom);
    this._applyTransform();
  }

  zoomOut() {
    this.scale = Math.max(this.scale - this.options.zoomStep, this.options.minZoom);
    this._applyTransform();
  }

  resetZoom() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this._applyTransform();
  }

  oneToOne() {
    this.scale = 1;
    this._applyTransform();
  }

  rotate(degrees) {
    if (!this.currentImage) return;
    const currentRotation = parseInt(this.currentImage.dataset.rotation || '0', 10);
    const newRotation = currentRotation + degrees;
    this.currentImage.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale}) rotate(${newRotation}deg)`;
    this.currentImage.dataset.rotation = String(newRotation);
  }

  flipHorizontal() {
    if (!this.currentImage) return;
    const currentFlip = this.currentImage.dataset.flipH === 'true';
    this.currentImage.dataset.flipH = String(!currentFlip);
    const scaleX = currentFlip ? 1 : -1;
    const scaleY = this.currentImage.dataset.flipV === 'true' ? -1 : 1;
    this.currentImage.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale * scaleX}, ${this.scale * scaleY}) rotate(${this.currentImage.dataset.rotation || '0'}deg)`;
  }

  flipVertical() {
    if (!this.currentImage) return;
    const currentFlip = this.currentImage.dataset.flipV === 'true';
    this.currentImage.dataset.flipV = String(!currentFlip);
    const scaleX = this.currentImage.dataset.flipH === 'true' ? -1 : 1;
    const scaleY = currentFlip ? 1 : -1;
    this.currentImage.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale * scaleX}, ${this.scale * scaleY}) rotate(${this.currentImage.dataset.rotation || '0'}deg)`;
  }

  toggleCurrentSelection() {
    if (this.selectedIndices.has(this.currentIndex)) {
      this.selectedIndices.delete(this.currentIndex);
    } else {
      this.selectedIndices.add(this.currentIndex);
    }
    this._renderThumbnails();
    this._renderToolbar();
  }

  // Метод для бесшовного обновления данных галереи без закрытия
  async _refreshGalleryData(entryId) {
    if (!this.dialogInstance || typeof this.dialogInstance.refreshGalleryData !== 'function') {
      console.warn('[PHG CustomViewer] Dialog instance not available for refresh');
      return;
    }
    
    try {
      // Получаем обновленные данные из dialog instance
      let newData = await this.dialogInstance.refreshGalleryData(entryId);
      
      // Если для текущего entryId нет данных, пробуем найти любую другую активную запись
      if (!newData || !newData.sources || newData.sources.length === 0) {
        console.log('[PHG CustomViewer] No data for entryId:', entryId, 'trying to find another active entry');
        
        // Берем первую доступную запись из обновленного состояния
        const allEntries = this.dialogInstance.state.entries;
        for (const entry of allEntries) {
          const sources = window.buildImageSources(entry, this.dialogInstance.api);
          if (sources && sources.length > 0) {
            newData = { entry, sources };
            console.log('[PHG CustomViewer] Found alternative entry:', entry.id, 'with', sources.length, 'images');
            break;
          }
        }
      }
      
      if (!newData || !newData.sources || newData.sources.length === 0) {
        // Если данных нет вообще - закрываем галерею (это единственный случай закрытия)
        console.log('[PHG CustomViewer] No images left in any entry, closing gallery');
        this.close();
        return;
      }
      
      // Сохраняем текущий индекс, если возможно
      const currentFilename = this.currentImage?.dataset.filename;
      let newIndex = 0;
      
      // Пытаемся найти текущее изображение в новых данных
      if (currentFilename) {
        const foundIndex = newData.sources.findIndex(s => s.filename === currentFilename);
        if (foundIndex !== -1) {
          newIndex = foundIndex;
        } else {
          // Если текущее изображение было удалено, выбираем соседнее
          // Предпочитаем следующее изображение, если оно есть, иначе предыдущее
          const oldIndex = this.currentIndex;
          if (oldIndex < newData.sources.length) {
            newIndex = oldIndex; // Остаемся на том же индексе если возможно
          } else {
            newIndex = Math.max(0, newData.sources.length - 1); // Иначе берем последнее
          }
        }
      } else {
        // Если не было текущего изображения (первый запуск), берем последнее или среднее
        // чтобы не было резкого скачка к первому изображению
        newIndex = Math.floor(newData.sources.length / 2);
      }
      
      // Обновляем данные галереи
      this.images = newData.sources.map((item, index) => ({
        ...item,
        index,
        entryId: item.entryId ?? newData.entry.id,
      }));
      
      // Обновляем currentIndex и перерисовываем
      this.currentIndex = Math.min(Math.max(newIndex, 0), this.images.length - 1);
      this.scale = 1;
      this.translateX = 0;
      this.translateY = 0;
      this.selectedIndices.clear();
      
      this._renderCurrentImage();
      this._renderThumbnails();
      this._renderToolbar();
      
      console.log('[PHG CustomViewer] Gallery refreshed seamlessly');
      
    } catch (error) {
      console.error('[PHG CustomViewer] Refresh gallery data error:', error);
    }
  }

  // Action handlers
  async _handleUndoDelete() {
    try {
      const response = await fetch('/api/phg/undo_delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      
      if (result.success) {
        alert('Successfully restored the last deleted image!');
        // Бесшовное обновление: запрашиваем обновленные данные и обновляем галерею без закрытия
        await this._refreshGalleryData(this.activeEntryId);
      } else {
        alert(result.error || 'No files to restore or restore failed.');
      }
    } catch (error) {
      console.error('[PHG CustomViewer] Undo delete error:', error);
      alert('Error restoring file: ' + error.message);
    }
  }

  async _handleSave() {
    if (!this.currentImage) return;
    
    if (this.dialogInstance && typeof this.dialogInstance.saveSelectedImageFromGallery === 'function') {
      await this.dialogInstance.saveSelectedImageFromGallery(this.currentImage);
    } else {
      const src = this.currentImage.src;
      if (!src) return;
      try {
        const response = await fetch(src);
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `prompt_${this.currentImage.dataset.entryId || Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
      } catch (error) {
        console.error('[PHG CustomViewer] Save image error:', error);
      }
    }
  }

  async _handleDeleteSelectedFromHistory() {
    if (this.selectedIndices.size === 0) {
      alert("No images selected");
      return;
    }
    
    const count = this.selectedIndices.size;
    if (!confirm(`Delete ${count} selected image(s) from History?\n\nThis will remove them from gallery only. Files will remain on disk.\n\nThis action cannot be undone!`)) {
      return;
    }
    
    const indicesToDelete = Array.from(this.selectedIndices);
    let successCount = 0;
    
    console.log('[PHG CustomViewer] Starting batch delete from history, count:', count);
    
    for (const index of indicesToDelete) {
      const item = this.images[index];
      if (!item || !item.filename) continue;
      
      try {
        console.log('[PHG CustomViewer] Deleting from history:', item.filename);
        const response = await fetch('/api/phg/delete_image_from_history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            entry_id: item.entryId || this.activeEntryId, 
            filename: item.filename, 
            subfolder: item.subfolder || '', 
            type: item.type || 'output' 
          })
        });
        const result = await response.json();
        if (result.success) {
          successCount++;
          console.log('[PHG CustomViewer] Successfully deleted from history:', item.filename);
        } else {
          console.warn('[PHG CustomViewer] Failed to delete from history:', item.filename, result.error);
        }
      } catch (error) {
        console.error('[PHG CustomViewer] Batch delete from history error', error);
      }
    }
    
    this.selectedIndices.clear();
    
    console.log('[PHG CustomViewer] Deletion complete, successCount:', successCount, 'of', count);
    
    // Сохраняем activeEntryId перед обновлением диалога
    const entryIdToRefresh = this.activeEntryId;
    const wasOpen = this.isOpen;
    
    console.log('[PHG CustomViewer] Before refresh - isOpen:', wasOpen, 'entryIdToRefresh:', entryIdToRefresh);
    
    // Сначала обновляем состояние диалога (чтобы this.state.entries был актуальным)
    if (this.dialogInstance && typeof this.dialogInstance.refresh === 'function') {
      console.log('[PHG CustomViewer] Refreshing dialog instance...');
      await this.dialogInstance.refresh();
    }
    
    // Небольшая задержка чтобы убедиться что диалог обновился
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Бесшовное обновление: запрашиваем обновленные данные и обновляем галерею без закрытия
    console.log('[PHG CustomViewer] Refreshing gallery data for entryId:', entryIdToRefresh);
    await this._refreshGalleryData(entryIdToRefresh);
    
    console.log('[PHG CustomViewer] After refresh - isOpen:', this.isOpen);
    
    if (successCount < count) {
      alert(`Deleted ${successCount} of ${count} images from history. Some deletions may have failed.`);
    }
  }

  async _handleDeleteSelectedEverywhere() {
    if (this.selectedIndices.size === 0) {
      alert("No images selected");
      return;
    }
    
    const count = this.selectedIndices.size;
    if (!confirm(`Delete ${count} selected image(s) everywhere?\n\nThis will:\n- Remove from history database\n- Delete archived image files\n- Delete archived prompt files (if exists)\n\nThis action cannot be undone!`)) {
      return;
    }
    
    const indicesToDelete = Array.from(this.selectedIndices);
    let successCount = 0;
    
    console.log('[PHG CustomViewer] Starting batch delete everywhere, count:', count);
    
    for (const index of indicesToDelete) {
      const item = this.images[index];
      if (!item || !item.filename) continue;
      
      try {
        console.log('[PHG CustomViewer] Deleting everywhere:', item.filename);
        const response = await fetch('/api/phg/delete_image_everywhere', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            entry_id: item.entryId || this.activeEntryId, 
            filename: item.filename, 
            subfolder: item.subfolder || '', 
            type: item.type || 'output' 
          })
        });
        const result = await response.json();
        if (result.success) {
          successCount++;
          console.log('[PHG CustomViewer] Successfully deleted:', item.filename);
        } else {
          console.warn('[PHG CustomViewer] Failed to delete:', item.filename, result.error);
        }
      } catch (error) {
        console.error('[PHG CustomViewer] Batch delete everywhere error', error);
      }
    }
    
    this.selectedIndices.clear();
    
    console.log('[PHG CustomViewer] Deletion complete, successCount:', successCount, 'of', count);
    
    // Сохраняем activeEntryId перед обновлением диалога
    const entryIdToRefresh = this.activeEntryId;
    const wasOpen = this.isOpen;
    
    console.log('[PHG CustomViewer] Before refresh - isOpen:', wasOpen, 'entryIdToRefresh:', entryIdToRefresh);
    
    // Сначала обновляем состояние диалога (чтобы this.state.entries был актуальным)
    if (this.dialogInstance && typeof this.dialogInstance.refresh === 'function') {
      console.log('[PHG CustomViewer] Refreshing dialog instance...');
      await this.dialogInstance.refresh();
    }
    
    // Небольшая задержка чтобы убедиться что диалог обновился
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Бесшовное обновление: запрашиваем обновленные данные и обновляем галерею без закрытия
    console.log('[PHG CustomViewer] Refreshing gallery data for entryId:', entryIdToRefresh);
    await this._refreshGalleryData(entryIdToRefresh);
    
    console.log('[PHG CustomViewer] After refresh - isOpen:', this.isOpen);
    
    if (successCount < count) {
      alert(`Deleted ${successCount} of ${count} images. Some deletions may have failed.`);
    }
  }
}

// Export factory function
export function createCustomViewer(options = {}) {
  return new CustomViewer(options);
}
