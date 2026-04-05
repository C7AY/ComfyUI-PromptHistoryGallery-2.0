"""Shared helpers for syncing ComfyUI prompt completions with stored history."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from .archiver import archive_generated_files, update_archive_settings
from .normalizers import normalize_output_payload
from .registry import consume_prompt_entries
from .storage import get_prompt_history_storage

LOGGER = logging.getLogger(__name__)


def _extract_generated_files(history_result: Any) -> List[Dict[str, Any]]:
    if not isinstance(history_result, dict):
        return []

    outputs = history_result.get("outputs")
    if not isinstance(outputs, dict):
        return []

    collected: List[Dict[str, Any]] = []

    for node_outputs in outputs.values():
        if not isinstance(node_outputs, dict):
            continue
        for key in ("images", "files"):
            entries = node_outputs.get(key)
            if not isinstance(entries, list):
                continue
            for entry in entries:
                record = normalize_output_payload(entry)
                if record:
                    collected.append(record.to_dict())

    # Heuristic: If we have any "output" (saved) images, ignore "temp" (preview) images.
    # This prevents intermediate controlnet previews from cluttering the history
    # when a real save node is present.
    has_saved_output = any(item.get("type") == "output" for item in collected)
    if has_saved_output:
        collected = [item for item in collected if item.get("type") == "output"]

    return collected


def _extract_prompt_texts(prompt_payload: Any) -> List[Tuple[str, str]]:
    if not isinstance(prompt_payload, dict):
        return []
    prompts: List[Tuple[str, str]] = []
    for node in prompt_payload.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "PromptHistoryInput":
            continue
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            prompt_value = inputs.get("prompt")
            negative_value = inputs.get("negative_prompt", "")
            if isinstance(prompt_value, str) and prompt_value:
                prompts.append((prompt_value, negative_value if isinstance(negative_value, str) else ""))
    return prompts


def _resolve_entry_ids(
    prompt_id: Optional[str],
    prompt_payload: Any,
    storage,
) -> List[str]:
    """
    Derive history entry ids associated with a completed prompt.
    """
    entry_ids = consume_prompt_entries(prompt_id)
    if entry_ids:
        return entry_ids

    prompt_pairs = _extract_prompt_texts(prompt_payload)
    if not prompt_pairs:
        return []

    # Try to find entries using both prompt and negative_prompt
    resolved_ids: List[str] = []
    for prompt_text, negative_text in prompt_pairs:
        entry_id = storage.find_entry_id_for_prompt_and_negative(prompt_text, negative_text)
        if entry_id:
            resolved_ids.append(entry_id)
    
    return resolved_ids


def _notify_clients(
    server: Optional[Any], entry_ids: List[str], files: List[Dict[str, Any]]
) -> None:
    if server is None or not entry_ids:
        return
    try:
        payload: Dict[str, Any] = {"entry_ids": list(entry_ids)}
        if files:
            payload["files"] = [dict(item) for item in files]
        server.send_sync("PromptHistoryGallery.updated", payload)
    except Exception:  # pragma: no cover
        LOGGER.exception("Failed to notify clients about history update")


def _get_prompts_for_entry(entry_id: str, prompt_payload: Any) -> Tuple[str, str]:
    """Extract positive and negative prompts for a given entry."""
    positive_prompt = ""
    negative_prompt = ""
    
    if not isinstance(prompt_payload, dict):
        return positive_prompt, negative_prompt
    
    for node in prompt_payload.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "PromptHistoryInput":
            continue
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            prompt_value = inputs.get("prompt", "")
            negative_value = inputs.get("negative_prompt", "")
            if isinstance(prompt_value, str):
                positive_prompt = prompt_value
            if isinstance(negative_value, str):
                negative_prompt = negative_value
            break
    
    return positive_prompt, negative_prompt


def handle_prompt_completion(
    prompt_id: Optional[str],
    history_result: Any,
    prompt_payload: Any,
    server: Optional[Any],
) -> None:
    storage = get_prompt_history_storage()

    entry_ids = _resolve_entry_ids(prompt_id, prompt_payload, storage)
    if not entry_ids:
        return

    # Store the full prompt payload in metadata for later use
    if prompt_payload:
        for entry_id in entry_ids:
            storage.update_metadata(entry_id, {"comfyui_prompt": prompt_payload})

    files = _extract_generated_files(history_result)
    if files:
        # Archive files if enabled (use first entry's prompts)
        positive_prompt, negative_prompt = "", ""
        if entry_ids:
            positive_prompt, negative_prompt = _get_prompts_for_entry(entry_ids[0], prompt_payload)
        
        # Archive files for each entry
        archived_files_list = []
        for entry_id in entry_ids:
            archived_files = archive_generated_files(
                files, 
                entry_id, 
                positive_prompt, 
                negative_prompt
            )
            archived_files_list.append((entry_id, archived_files))
        
        # Store archived file paths in database
        for entry_id, archived_files in archived_files_list:
            if archived_files:
                storage.add_outputs_for_entries([entry_id], archived_files)

    storage.touch_entries(entry_ids)
    _notify_clients(server, entry_ids, files)
