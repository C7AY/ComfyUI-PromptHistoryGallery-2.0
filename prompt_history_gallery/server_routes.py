"""
Server routes for archive settings management.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from aiohttp import web

from .archiver import get_archive_settings, update_archive_settings

LOGGER = logging.getLogger(__name__)


def setup_server_routes(server: Any) -> None:
    """Setup archive settings routes on the server."""
    
    async def get_archive_settings_route(request):
        """Get current archive settings."""
        settings = get_archive_settings()
        return web.json_response({"success": True, "settings": settings})
    
    async def update_archive_settings_route(request):
        """Update archive settings."""
        try:
            data = await request.json()
            enabled = bool(data.get("enabled", False))
            folder_name = str(data.get("folder_name", "archive"))
            prompts_enabled = bool(data.get("prompts_enabled", False))
            
            update_archive_settings(enabled, folder_name, prompts_enabled)
            
            return web.json_response({
                "success": True, 
                "message": "Archive settings updated"
            })
        except Exception as e:
            return web.json_response({
                "success": False, 
                "error": str(e)
            })
    
    async def create_archive_folder_route(request):
        """Create archive directory manually."""
        try:
            data = {}
            if await request.body_exists():
                body = await request.body()
                body_text = body.decode('utf-8').strip() if body else ''
                if body_text:
                    try:
                        data = json.loads(body_text)
                        # If it's just a string (not an object), wrap it
                        if isinstance(data, str):
                            data = {"folder_name": data}
                        elif not isinstance(data, dict):
                            data = {}
                    except (json.JSONDecodeError, ValueError) as e:
                        LOGGER.warning(f"[PHG Archive] Invalid JSON in create folder request: {body_text}, error: {e}")
                        # Try to extract folder name from raw text as fallback
                        if body_text:
                            data = {"folder_name": body_text.strip('"\'')}
                        else:
                            data = {}
            
            folder_name = str(data.get("folder_name", "archive")).strip().strip('"\'') or "archive"
            
            # Get output directory
            try:
                from folder_paths import get_output_directory
                output_dir = Path(get_output_directory())
            except Exception:
                comfyui_root = Path(__file__).resolve().parent.parent.parent
                output_dir = comfyui_root / "output"
            
            if not output_dir.exists():
                return web.json_response({
                    "success": False,
                    "message": f"Output directory not found: {output_dir}"
                })
            
            archive_dir = output_dir / folder_name
            
            # Check if folder already exists
            if archive_dir.exists():
                if archive_dir.is_dir():
                    # Return 409 Conflict for existing folder
                    return web.json_response({
                        "success": False,
                        "exists": True,
                        "message": f"Folder '{folder_name}' already exists in output directory",
                        "path": str(archive_dir)
                    }, status=409)
                else:
                    return web.json_response({
                        "success": False,
                        "message": f"A file named '{folder_name}' already exists in output directory"
                    }, status=409)
            
            # Create the folder
            archive_dir.mkdir(parents=True, exist_ok=False)
            
            return web.json_response({
                "success": True,
                "exists": False,
                "message": f"Folder '{folder_name}' created successfully in output directory",
                "path": str(archive_dir)
            })
            
        except Exception as e:
            return web.json_response({
                "success": False,
                "error": str(e)
            })
    
    # Register routes with /api/ prefix for ComfyUI API compatibility
    server.app.router.add_get("/api/prompt-history-gallery/archive-settings", get_archive_settings_route)
    server.app.router.add_post("/api/prompt-history-gallery/archive-settings", update_archive_settings_route)
    server.app.router.add_post("/api/prompt-history-gallery/create-archive-folder", create_archive_folder_route)
    
    LOGGER.info("[PHG Archive] Archive routes registered successfully")
