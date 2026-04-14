"""
Entry point for ComfyUI to discover the Prompt History Gallery nodes.
"""

import logging
from aiohttp import web
from server import PromptServer

LOGGER = logging.getLogger(__name__)

from .prompt_history_gallery import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
    get_prompt_history_storage,
)
from .prompt_history_gallery.server_routes import setup_server_routes

WEB_DIRECTORY = "./web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]


def _serialize_entry(entry):
    payload = entry.to_dict()
    if not isinstance(payload.get("files"), list):
        payload["files"] = []
    return payload


# Setup archive settings routes
setup_server_routes(PromptServer.instance)


@PromptServer.instance.routes.get("/prompt-history")
async def list_prompt_history(request):
    storage = get_prompt_history_storage()
    entries = [_serialize_entry(entry) for entry in storage.list()]
    return web.json_response({"entries": entries})


@PromptServer.instance.routes.delete("/prompt-history/{entry_id}")
async def delete_prompt_history_entry(request):
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    storage = get_prompt_history_storage()
    deleted = storage.delete(entry_id)
    if not deleted:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.delete("/prompt-history/output/{entry_id}")
async def delete_output_file_from_history(request):
    """Delete a specific output file from history (database only)."""
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    
    try:
        data = await request.json()
    except Exception:
        data = {}
    
    filename = data.get("filename", "")
    subfolder = data.get("subfolder", "")
    file_type = data.get("type", "")
    
    if not filename:
        raise web.HTTPBadRequest(text="filename is required")
    
    storage = get_prompt_history_storage()
    deleted = storage.delete_output_file(entry_id, filename, subfolder, file_type)
    if not deleted:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True})


@PromptServer.instance.routes.post("/prompt-history/delete-everywhere/{entry_id}")
async def delete_output_file_everywhere(request):
    """Delete a specific output file from history and archive files."""
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    
    try:
        data = await request.json()
    except Exception:
        data = {}
    
    filename = data.get("filename", "")
    subfolder = data.get("subfolder", "")
    file_type = data.get("type", "")
    
    if not filename:
        raise web.HTTPBadRequest(text="filename is required")
    
    storage = get_prompt_history_storage()
    
    # First delete from database
    deleted = storage.delete_output_file(entry_id, filename, subfolder, file_type)
    
    # Then delete actual files from archive if they exist
    files_deleted = False
    try:
        from .prompt_history_gallery.archiver import _get_archive_directory
        archive_dir = _get_archive_directory()
        if archive_dir:
            # Delete image file
            image_path = archive_dir / filename
            if image_path.exists():
                image_path.unlink()
                files_deleted = True
            
            # Try to delete associated prompt text file
            base_name = filename.rsplit('.', 1)[0] if '.' in filename else filename
            prompt_path = archive_dir / f"{base_name}.txt"
            if prompt_path.exists():
                prompt_path.unlink()
                files_deleted = True
    except Exception as e:
        LOGGER.warning(f"[PHG] Failed to delete archive files: {e}")
    
    if not deleted:
        raise web.HTTPNotFound()
    return web.json_response({"ok": True, "files_deleted": files_deleted})


@PromptServer.instance.routes.post("/prompt-history/delete-others/{entry_id}")
async def delete_others_except_selected(request):
    """Delete all outputs for an entry except the specified one."""
    entry_id = request.match_info.get("entry_id")
    if not entry_id:
        raise web.HTTPBadRequest()
    
    try:
        data = await request.json()
    except Exception:
        data = {}
    
    keep_filename = data.get("filename", "")
    keep_subfolder = data.get("subfolder", "")
    keep_type = data.get("type", "")
    
    if not keep_filename:
        raise web.HTTPBadRequest(text="filename is required")
    
    storage = get_prompt_history_storage()
    deleted_count = storage.delete_outputs_except(entry_id, keep_filename, keep_subfolder, keep_type)
    return web.json_response({"ok": True, "deleted_count": deleted_count})


@PromptServer.instance.routes.delete("/prompt-history")
async def clear_prompt_history(request):
    storage = get_prompt_history_storage()
    storage.clear()
    return web.json_response({"ok": True})
