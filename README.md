# ComfyUI-PromptHistoryGallery 2.0

Capture ComfyUI prompts and generated images with a history dialog, popup previews, and a full gallery viewer. Save individual images directly from the gallery or history with a single click.

## Features

- **Save Images Easily**: Save selected images directly from the Gallery Viewer or History Dialog using the "Save Selected Image" button.
- **Prompt History**: Save prompts to history while still returning the `CONDITIONING` output for your workflow.
- **Gallery Viewer**: View the latest thumbnail and total image count per prompt, and jump straight into a full-screen gallery with navigation and zoom.
- **Search & Manage**: Search history by prompt text or tags, then send to node, copy, or delete with quick actions.
- **Popup Previews**: See popup previews when generations finish; click a preview to open the gallery.
- **Customizable Settings**: Tune history limit, frequent-prompt highlighting, and popup preview size/duration/position in the Settings tab.

## Prompt History Input Node

<img width="350" alt="Screenshot of prompt history node" src="https://github.com/user-attachments/assets/00837c62-24f9-472f-a29a-b72e28ffcce6" /><br>

- `CLIP`: Connect the CLIP text encoder that should be used to embed the prompt.
- `Prompt`: Provide any text prompt. The node saves it to history and returns a matching `CONDITIONING`.

**Output:**
- `conditioning`: The `CONDITIONING` tensor produced by encoding the prompt with the supplied CLIP model.

The node executes on every graph run so repeated prompts are captured. Each execution appends or updates an entry in a SQLite database (default: `prompt_history_gallery/data/prompt_history.db`). Set the `COMFYUI_PROMPT_HISTORY_DIR` environment variable to override the storage location.

## History Dialog + Popup Preview

<img width="500" alt="Screenshot of prompt history window" src="https://github.com/user-attachments/assets/9d3e3633-ed31-48b6-8cf8-7c40a4b73c34" /><br>
<img width="500" alt="Screenshot of image preview" src="https://github.com/user-attachments/assets/2e1a971f-dfa1-4b3b-84fa-a7beceadcdaf" />

- **History Button**: Each `Prompt History Input` node includes a `History` button. Clicking it opens a dialog with recent prompts grouped by text and sorted by recent use.
- **Search & Actions**: Search by prompt text or tags. Entries show the latest preview, image count, and tags. Actions include:
    - Send the prompt back to the selected node (falls back to copy if no node is active).
    - Copy prompt to clipboard.
    - Delete entry.
    - Open the full **Gallery Viewer**.
    - **Save Image**: A "Save Image" button is available for entries with images to download them immediately.
- **Sync**: The dialog refreshes when new prompts finish so it stays in sync with the latest generations.
- **Popup Previews**: Appear when images complete; click a preview to open the gallery.
- **Settings**: Use the Settings tab to toggle popup previews, adjust preview duration/size, change the history limit, and tune frequent-prompt highlighting.

## Gallery Viewer

<img width="800" alt="Screenshot of gallery viewer" src="https://github.com/user-attachments/assets/PLACEHOLDER_FOR_GALLERY_SCREENSHOT" /><br>

Clicking an image in the History Dialog or a Popup Preview opens the full-screen Gallery Viewer.

- **Navigation**: Browse through all images associated with a prompt using next/previous buttons or keyboard arrows.
- **Zoom & Pan**: Use mouse wheel or pinch gestures to zoom, and drag to pan.
- **Save Selected Image**: 
    - A prominent **"Save Selected Image"** button is located between the image title and the toolbar.
    - Clicking this button instantly downloads the currently displayed image.
    - Works seamlessly while navigating through multiple images.
- **Toolbar**: Access standard Viewer.js controls for zoom, rotate, flip, and reset.

## Development

### Formatting

- One-shot fixer: `scripts/format.sh` (needs `pipx` and Node) runs Ruff via `pipx run --spec ruff==0.14.10` plus Prettier `-w` to apply fixes.
- Install dev tools: `pip install -e .[dev]` (provides Ruff).
- Python: run `ruff format --check .` and `ruff check --select I .` (add `--fix` locally if you want auto-fixes).
- Web/JS/CSS: run `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` (honors `.prettierignore`; `web/vendor/` is excluded).
- CI: `.github/workflows/ci.yml` runs `ruff format --check .`, `ruff check --select I .`, and `npx prettier@3.7.4 --check "web/**/*.{js,jsx,ts,tsx,css,scss,html,json}"` on pushes/PRs to `main`.

### Release

- Release bundles are published by GitHub Actions; no manual `node.zip` rebuild is required.
