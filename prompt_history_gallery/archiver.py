"""
Archive manager for saving copies of generated images and prompt text files.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

LOGGER = logging.getLogger(__name__)

# Global settings (will be updated from client)
_archive_enabled = False
_archive_folder_name = "archive"
_archive_prompts_enabled = False


def update_archive_settings(
    enabled: bool,
    folder_name: str,
    prompts_enabled: bool
) -> None:
    """Update archive settings from client."""
    global _archive_enabled, _archive_folder_name, _archive_prompts_enabled
    _archive_enabled = enabled
    _archive_folder_name = folder_name.strip() or "archive"
    _archive_prompts_enabled = prompts_enabled
    LOGGER.info(
        f"[PHG Archive] Settings updated: enabled={_archive_enabled}, "
        f"folder={_archive_folder_name}, prompts={_archive_prompts_enabled}"
    )
    
    # Pre-create archive directory if enabled to ensure it exists before first use
    if _archive_enabled:
        _get_archive_directory()


def get_archive_settings() -> Dict[str, Any]:
    """Get current archive settings."""
    return {
        "enabled": _archive_enabled,
        "folder_name": _archive_folder_name,
        "prompts_enabled": _archive_prompts_enabled,
    }


def _get_comfyui_output_dir() -> Optional[Path]:
    """Get the ComfyUI output directory."""
    try:
        from folder_paths import get_output_directory
        return Path(get_output_directory())
    except Exception:
        pass
    
    # Fallback: try to find output directory
    comfyui_root = Path(__file__).resolve().parent.parent.parent
    output_dir = comfyui_root / "output"
    if output_dir.exists():
        return output_dir
    
    return None


def _get_archive_directory() -> Optional[Path]:
    """Get the archive directory path."""
    if not _archive_enabled:
        LOGGER.debug("[PHG Archive] Archiving is disabled, skipping directory creation")
        return None
    
    output_dir = _get_comfyui_output_dir()
    if not output_dir:
        LOGGER.warning("[PHG Archive] Could not determine ComfyUI output directory")
        return None
    
    archive_dir = output_dir / _archive_folder_name
    try:
        archive_dir.mkdir(parents=True, exist_ok=True)
        LOGGER.info(f"[PHG Archive] Archive directory ready: {archive_dir}")
        return archive_dir
    except Exception as e:
        LOGGER.error(f"[PHG Archive] Failed to create archive directory: {e}")
        return None


def _generate_unique_filename(base_name: str, extension: str, directory: Path) -> str:
    """
    Generate a unique filename by adding a counter if file exists.
    Format: basename.ext, basename_1.ext, basename_2.ext, etc.
    """
    # Ensure base_name doesn't already have the extension
    if base_name.endswith(extension):
        base_name = base_name[:-len(extension)]
    
    counter = 0
    filename = f"{base_name}{extension}"
    
    while (directory / filename).exists():
        counter += 1
        filename = f"{base_name}_{counter}{extension}"
    
    return filename


def _split_filename(filename: str) -> tuple[str, str]:
    """
    Split filename into base name and extension.
    Returns (base_name, extension_with_dot).
    """
    name_parts = filename.rsplit('.', 1)
    if len(name_parts) == 2:
        return name_parts[0], '.' + name_parts[1]
    return filename, '.png'  # Default extension


def _copy_image_to_archive(
    source_path: Path,
    archive_dir: Path,
    original_filename: str
) -> Optional[str]:
    """
    Copy an image file to the archive directory.
    Returns the new filename in archive, or None if failed.
    """
    try:
        # Preserve original filename structure but ensure uniqueness
        base_name, ext = _split_filename(original_filename)
        
        unique_filename = _generate_unique_filename(base_name, ext, archive_dir)
        dest_path = archive_dir / unique_filename
        
        shutil.copy2(source_path, dest_path)
        LOGGER.info(f"[PHG Archive] Copied image: {original_filename} -> {unique_filename}")
        return unique_filename
    
    except Exception as e:
        LOGGER.error(f"[PHG Archive] Failed to copy image {original_filename}: {e}")
        return None


def _save_prompt_to_archive(
    archive_dir: Path,
    base_filename: str,
    positive_prompt: str,
    negative_prompt: str
) -> Optional[str]:
    """
    Save prompt text to a .txt file in the archive.
    Returns the filename, or None if failed.
    """
    if not _archive_prompts_enabled:
        return None
    
    try:
        # Use same base name as image, but with .txt extension
        base_name, _ = _split_filename(base_filename)
        
        # Ensure unique filename for prompt too
        unique_filename = _generate_unique_filename(base_name, '.txt', archive_dir)
        dest_path = archive_dir / unique_filename
        
        content = f"POSITIVE PROMPT:\n{positive_prompt}\n\nNEGATIVE PROMPT:\n{negative_prompt}\n"
        
        with open(dest_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        LOGGER.info(f"[PHG Archive] Saved prompt: {unique_filename}")
        return unique_filename
    
    except Exception as e:
        LOGGER.error(f"[PHG Archive] Failed to save prompt file: {e}")
        return None


def archive_generated_files(
    files: List[Dict[str, Any]],
    entry_id: str,
    positive_prompt: str = "",
    negative_prompt: str = ""
) -> List[Dict[str, Any]]:
    """
    Archive generated files and optionally their prompts.
    
    Args:
        files: List of file info dicts with filename, subfolder, type
        entry_id: History entry ID
        positive_prompt: Positive prompt text
        negative_prompt: Negative prompt text
    
    Returns:
        List of updated file info dicts with archived paths,
        or original list if archiving is disabled/failed.
    """
    if not _archive_enabled:
        LOGGER.debug("[PHG Archive] Archiving disabled, skipping")
        return files
    
    archive_dir = _get_archive_directory()
    if not archive_dir:
        LOGGER.warning("[PHG Archive] Archive directory not available, skipping archiving")
        return files
    
    LOGGER.info(f"[PHG Archive] Starting to archive {len(files)} files for entry {entry_id}")
    archived_files = []
    
    for file_info in files:
        filename = file_info.get("filename", "")
        subfolder = file_info.get("subfolder", "")
        file_type = file_info.get("type", "output")
        
        if not filename:
            archived_files.append(file_info)
            continue
        
        # Build source path
        if file_type == "output":
            output_dir = _get_comfyui_output_dir()
            if output_dir:
                source_path = output_dir / subfolder / filename if subfolder else output_dir / filename
            else:
                archived_files.append(file_info)
                continue
        else:
            # For temp files or unknown types, skip archiving
            archived_files.append(file_info)
            continue
        
        if not source_path.exists():
            LOGGER.warning(f"[PHG Archive] Source file not found: {source_path}")
            archived_files.append(file_info)
            continue
        
        # Copy image to archive
        archived_filename = _copy_image_to_archive(source_path, archive_dir, filename)
        
        if archived_filename:
            # Create new file info with archived path
            archived_info = {
                "filename": archived_filename,
                "subfolder": _archive_folder_name,
                "type": "output",
                "entry_id": entry_id,
            }
            
            # Save prompt file if enabled (only once per entry, use first image)
            if _archive_prompts_enabled and len(archived_files) == 0 and (positive_prompt or negative_prompt):
                _save_prompt_to_archive(
                    archive_dir,
                    archived_filename,
                    positive_prompt,
                    negative_prompt
                )
            
            archived_files.append(archived_info)
        else:
            # Keep original if archiving failed
            archived_files.append(file_info)
    
    return archived_files
