"""
Server routes for archive settings management and image deletion.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Optional, List

from aiohttp import web

from .archiver import get_archive_settings, update_archive_settings, _get_archive_directory
from .metadata_extractor import extract_metadata_from_archive_images, normalize_extracted_metadata

LOGGER = logging.getLogger(__name__)


def _get_db_connection():
    """Helper to get DB connection safely."""
    db = None
    
    try:
        from . import get_db
        db = get_db()
        if db:
            LOGGER.debug("[PHG] DB connection established via package import")
            return db
    except (ImportError, AttributeError, Exception) as e:
        LOGGER.debug(f"[PHG] Package import failed: {e}")
        pass
    
    try:
        import sys
        for module_name, module in sys.modules.items():
            if hasattr(module, 'get_db') and callable(getattr(module, 'get_db')):
                db = module.get_db()
                if db:
                    LOGGER.debug(f"[PHG] DB connection established via sys.modules[{module_name}]")
                    return db
    except Exception as e:
        LOGGER.debug(f"[PHG] Sys.modules search failed: {e}")
        pass

    try:
        db_path = Path(__file__).parent / "data" / "prompt_history.db"
        if db_path.exists():
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row
            LOGGER.warning(f"[PHG] Using fallback direct DB connection: {db_path}")
            return conn
        else:
            LOGGER.error(f"[PHG] Fallback DB path not found: {db_path}")
    except Exception as e:
        LOGGER.error(f"[PHG] Fallback DB connection failed: {e}")

    raise RuntimeError("Database connection not available.")


def _get_output_directory():
    """Get ComfyUI output directory."""
    try:
        from folder_paths import get_output_directory
        return Path(get_output_directory())
    except Exception:
        comfyui_root = Path(__file__).resolve().parent.parent.parent
        return comfyui_root / "output"


def _delete_file_safely(filepath: Path) -> bool:
    """Safely delete a file if it exists."""
    try:
        if filepath.exists():
            filepath.unlink()
            LOGGER.info(f"[PHG] Deleted file: {filepath}")
            return True
        else:
            LOGGER.debug(f"[PHG] File not found (skipping): {filepath}")
            return False
    except Exception as e:
        LOGGER.error(f"[PHG] Error deleting file {filepath}: {e}")
        return False


def _notify_history_update(server):
    """Send event to frontend to refresh history."""
    try:
        # Пытаемся отправить событие через API сервера, если есть доступ
        # В рамках ComfyUI это обычно делается через server.send_sync
        if hasattr(server, 'send_sync'):
            server.send_sync("PromptHistoryGallery.updated", {})
        elif hasattr(server, 'app') and hasattr(server.app, 'send_sync'): # Альтернативный путь
             server.app.send_sync("PromptHistoryGallery.updated", {})
    except Exception as e:
        LOGGER.debug(f"[PHG] Could not send update notification: {e}")


def setup_server_routes(server: Any) -> None:
    """Setup archive settings and deletion routes on the server."""
    
    async def get_archive_settings_route(request):
        """Get current archive settings."""
        try:
            settings = get_archive_settings()
            return web.json_response({"success": True, "settings": settings})
        except Exception as e:
            LOGGER.error(f"[PHG] Error getting archive settings: {e}")
            return web.json_response({"success": False, "error": str(e)}, status=500)
    
    async def update_archive_settings_route(request):
        """Update archive settings."""
        try:
            data = await request.json()
            enabled = bool(data.get("enabled", False))
            folder_name = str(data.get("folder_name", "archive"))
            import re
            folder_name = re.sub(r'[^a-zA-Z0-9]', '', folder_name) or "archive"
            prompts_enabled = bool(data.get("prompts_enabled", False))
            
            update_archive_settings(enabled, folder_name, prompts_enabled)
            
            return web.json_response({
                "success": True, 
                "message": "Archive settings updated"
            })
        except Exception as e:
            LOGGER.error(f"[PHG] Error updating archive settings: {e}")
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
                        if isinstance(data, str):
                            data = {"folder_name": data}
                        elif not isinstance(data, dict):
                            data = {}
                    except (json.JSONDecodeError, ValueError) as e:
                        LOGGER.warning(f"[PHG Archive] Invalid JSON: {body_text}, error: {e}")
                        if body_text:
                            data = {"folder_name": body_text.strip('"\'')}
                        else:
                            data = {}
            
            folder_name = str(data.get("folder_name", "archive")).strip().strip('"\'') or "archive"
            import re
            folder_name = re.sub(r'[^a-zA-Z0-9]', '', folder_name) or "archive"
            
            output_dir = _get_output_directory()
            
            if not output_dir.exists():
                return web.json_response({
                    "success": False,
                    "message": f"Output directory not found: {output_dir}"
                })
            
            archive_dir = output_dir / folder_name
            
            if archive_dir.exists():
                if archive_dir.is_dir():
                    return web.json_response({
                        "success": False,
                        "exists": True,
                        "message": f"Folder '{folder_name}' already exists",
                        "path": str(archive_dir)
                    }, status=409)
                else:
                    return web.json_response({
                        "success": False,
                        "message": f"A file named '{folder_name}' already exists"
                    }, status=409)
            
            archive_dir.mkdir(parents=True, exist_ok=False)
            
            return web.json_response({
                "success": True,
                "exists": False,
                "message": f"Folder '{folder_name}' created successfully",
                "path": str(archive_dir)
            })
            
        except Exception as e:
            LOGGER.error(f"[PHG] Error creating archive folder: {e}")
            return web.json_response({
                "success": False,
                "error": str(e)
            })

    # ==========================================================
    # ЭНДПОИНТ: Удаление изображения из истории
    # ==========================================================
    async def delete_image_from_history_route(request):
        """Delete a specific image from the database by entry_id, filename, subfolder, type."""
        db = None
        try:
            data = await request.json()
            entry_id = data.get("entry_id")
            filename = data.get("filename")
            subfolder = data.get("subfolder", "")
            img_type = data.get("type", "output")
            
            LOGGER.info(f"[PHG] DELETE FROM HISTORY: Entry={entry_id}, File={filename}")

            if not entry_id or not filename:
                return web.json_response(
                    {"success": False, "error": "Missing entry_id or filename"}, 
                    status=400
                )

            db = _get_db_connection()
            cursor = db.cursor()

            cursor.execute("""
                SELECT id, subfolder, type 
                FROM prompt_history_output 
                WHERE entry_id = ? AND filename = ?
            """, (entry_id, filename))
            
            result = cursor.fetchone()
            
            if not result:
                LOGGER.error(f"[PHG] Image not found in DB: {filename}")
                return web.json_response(
                    {"success": False, "error": "Image not found in database"}, 
                    status=404
                )
            
            actual_subfolder = result[1]
            actual_type = result[2]
            
            cursor.execute("""
                DELETE FROM prompt_history_output 
                WHERE entry_id = ? AND filename = ? AND subfolder = ? AND type = ?
            """, (entry_id, filename, actual_subfolder, actual_type))
            
            deleted_count = cursor.rowcount
            LOGGER.info(f"[PHG] Deleted {deleted_count} row(s) from DB.")

            cursor.execute("""
                SELECT COUNT(*) 
                FROM prompt_history_output 
                WHERE entry_id = ?
            """, (entry_id,))
            
            count = cursor.fetchone()[0]
            
            prompt_deleted = False
            if count == 0:
                cursor.execute("DELETE FROM prompt_history WHERE id = ?", (entry_id,))
                prompt_deleted = True
                LOGGER.info(f"[PHG] Deleted prompt entry {entry_id} (no images left).")

            db.commit()
            
            # Уведомляем фронтенд об обновлении
            _notify_history_update(server)
            
            return web.json_response({
                "success": True, 
                "message": "Image removed from history",
                "deleted_count": deleted_count,
                "prompt_deleted": prompt_deleted
            })

        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Critical error: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # ==========================================================
    # ЭНДПОИНТ: Удаление изображения везде (файлы + БД)
    # ==========================================================
    async def delete_image_everywhere_route(request):
        """Delete image from DB and all filesystem locations (output + archive)."""
        db = None
        try:
            data = await request.json()
            entry_id = data.get("entry_id")
            filename = data.get("filename")
            subfolder = data.get("subfolder", "")
            img_type = data.get("type", "output")
            
            LOGGER.info(f"[PHG] DELETE EVERYWHERE: Entry={entry_id}, File={filename}")

            if not entry_id or not filename:
                return web.json_response(
                    {"success": False, "error": "Missing entry_id or filename"}, 
                    status=400
                )

            db = _get_db_connection()
            cursor = db.cursor()
            output_dir = _get_output_directory()
            
            archive_settings = get_archive_settings()
            archive_enabled = archive_settings.get("enabled", False)
            archive_folder = archive_settings.get("folder_name", "archive")
            archive_prompts_enabled = archive_settings.get("prompts_enabled", False)
            
            # 1. Удаляем из Output Directory
            file_path = output_dir / filename
            if subfolder:
                potential_path = output_dir / subfolder / filename
                if potential_path.exists():
                    file_path = potential_path
            
            files_deleted_count = 0
            if _delete_file_safely(file_path):
                files_deleted_count += 1

            # 2. Удаляем из Архива (с backup)
            if archive_enabled:
                archive_dir = output_dir / archive_folder
                # backup_dir = archive_dir / "backup"
                
                # Создаем папку backup если её нет
                # if not backup_dir.exists():
                #     try:
                #         backup_dir.mkdir(parents=True, exist_ok=True)
                #         LOGGER.info(f"[PHG] Created backup directory: {backup_dir}")
                #     except Exception as e:
                #         LOGGER.warning(f"[PHG] Could not create backup directory: {e}")
                
                if archive_dir.exists():
                    archive_file_path = archive_dir / filename
                    if subfolder:
                        sub_archive_path = archive_dir / subfolder / filename
                        if sub_archive_path.exists():
                            archive_file_path = sub_archive_path
                    
                    # Сначала копируем в backup перед удалением
                    # if archive_file_path.exists():
                    #     import shutil
                    #     import time
                    #     timestamp = int(time.time())
                    #     backup_filename = f"{filename}.backup.{timestamp}"
                    #     backup_path = backup_dir / backup_filename
                    #     try:
                    #         shutil.copy2(str(archive_file_path), str(backup_path))
                    #         LOGGER.info(f"[PHG] Backed up {archive_file_path} to {backup_path}")
                    #         
                    #         # Также бэкапим prompt файл если есть
                    #         if archive_prompts_enabled:
                    #             txt_filename = f"{Path(filename).stem}.txt"
                    #             txt_path = archive_dir / txt_filename
                    #             if subfolder:
                    #                 sub_txt_path = archive_dir / subfolder / txt_filename
                    #                 if sub_txt_path.exists():
                    #                     txt_path = sub_txt_path
                    #             
                    #             if txt_path.exists():
                    #                 txt_backup_name = f"{txt_filename}.backup.{timestamp}"
                    #                 txt_backup_path = backup_dir / txt_backup_name
                    #                 shutil.copy2(str(txt_path), str(txt_backup_path))
                    #                 LOGGER.info(f"[PHG] Backed up prompt {txt_path} to {txt_backup_path}")
                    #     except Exception as e:
                    #         LOGGER.error(f"[PHG] Backup failed: {e}")
                    
                    # Теперь удаляем из архива
                    if _delete_file_safely(archive_file_path):
                        files_deleted_count += 1
                    
                    if archive_prompts_enabled:
                        txt_filename = f"{Path(filename).stem}.txt"
                        txt_path = archive_dir / txt_filename
                        if subfolder:
                            sub_txt_path = archive_dir / subfolder / txt_filename
                            if sub_txt_path.exists():
                                txt_path = sub_txt_path
                        
                        if _delete_file_safely(txt_path):
                            LOGGER.info(f"[PHG] Deleted prompt text file: {txt_path}")

            # 3. Удаляем из БД
            cursor.execute("""
                SELECT id, subfolder, type 
                FROM prompt_history_output 
                WHERE entry_id = ? AND filename = ?
            """, (entry_id, filename))
            
            result = cursor.fetchone()
            if result:
                actual_subfolder = result[1]
                actual_type = result[2]
                
                cursor.execute("""
                    DELETE FROM prompt_history_output 
                    WHERE entry_id = ? AND filename = ? AND subfolder = ? AND type = ?
                """, (entry_id, filename, actual_subfolder, actual_type))
                
                LOGGER.info(f"[PHG] Deleted DB record for {filename}")

            # 4. Удаляем родительский промпт если изображений не осталось
            cursor.execute("SELECT COUNT(*) FROM prompt_history_output WHERE entry_id = ?", (entry_id,))
            count = cursor.fetchone()[0]
            
            prompt_deleted = False
            if count == 0:
                cursor.execute("DELETE FROM prompt_history WHERE id = ?", (entry_id,))
                prompt_deleted = True
                LOGGER.info(f"[PHG] Deleted prompt entry {entry_id}")

            db.commit()
            
            # Уведомляем фронтенд об обновлении
            _notify_history_update(server)
            
            LOGGER.info(f"[PHG] DELETE EVERYWHERE completed successfully for {filename}")
            
            return web.json_response({
                "success": True,
                "message": "Image and files deleted",
                "files_deleted": files_deleted_count > 0,
                "prompt_deleted": prompt_deleted
            })

        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Critical error: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # ==========================================================
    # ЭНДПОИНТ: Удалить все кроме выбранного
    # ==========================================================
    async def delete_others_except_selected_route(request):
        """
        Delete all images in an entry EXCEPT the specified one.
        """
        db = None
        try:
            data = await request.json()
            # main_entry_id используется только для логирования/контекста
            main_entry_id = data.get("entry_id") 
            keep_filename = data.get("keep_filename")
            keep_subfolder = data.get("keep_subfolder", "")
            keep_type = data.get("keep_type", "output")
            # Получаем явный список файлов на удаление от клиента
            files_to_delete = data.get("files_to_delete", [])
            
            LOGGER.info(f"[PHG] DELETE OTHERS: Keep={keep_filename}, ToDelete Count={len(files_to_delete)}")

            if not files_to_delete or not isinstance(files_to_delete, list):
                return web.json_response(
                    {"success": False, "error": "Missing or invalid 'files_to_delete' list"}, 
                    status=400
                )
            
            if not main_entry_id or not keep_filename:
                 return web.json_response(
                    {"success": False, "error": "Missing entry_id or keep_filename"}, 
                    status=400
                )

            db = _get_db_connection()
            cursor = db.cursor()
            output_dir = _get_output_directory()
            
            archive_settings = get_archive_settings()
            archive_enabled = archive_settings.get("enabled", False)
            archive_folder = archive_settings.get("folder_name", "archive")
            archive_prompts_enabled = archive_settings.get("prompts_enabled", False)
            
            archive_dir = output_dir / archive_folder if archive_enabled else None
            
            deleted_count = 0
            
            for file_info in files_to_delete:
                fname = file_info.get("filename")
                fsub = file_info.get("subfolder", "")
                # ftype = file_info.get("type", "output") # Тип пока не используем для поиска пути
                
                if not fname:
                    continue
                
                # 1. Удаляем из АРХИВА (с backup)
                if archive_enabled and archive_dir and archive_dir.exists():
                    # backup_dir = archive_dir / "backup"
                    
                    # Создаем папку backup если её нет
                    # if not backup_dir.exists():
                    #     try:
                    #         backup_dir.mkdir(parents=True, exist_ok=True)
                    #         LOGGER.info(f"[PHG] Created backup directory: {backup_dir}")
                    #     except Exception as e:
                    #         LOGGER.warning(f"[PHG] Could not create backup directory: {e}")
                    
                    arch_path = archive_dir / fname
                    if fsub:
                        pot_arch = archive_dir / fsub / fname
                        if pot_arch.exists():
                            arch_path = pot_arch
                    
                    # Сначала бэкапим перед удалением
                    # if arch_path.exists():
                    #     import shutil
                    #     import time
                    #     timestamp = int(time.time())
                    #     backup_filename = f"{fname}.backup.{timestamp}"
                    #     backup_path = backup_dir / backup_filename
                    #     try:
                    #         shutil.copy2(str(arch_path), str(backup_path))
                    #         LOGGER.info(f"[PHG] Backed up {arch_path} to {backup_path}")
                    #         
                    #         # Также бэкапим prompt файл если есть
                    #         if archive_prompts_enabled:
                    #             txt_name = f"{Path(fname).stem}.txt"
                    #             txt_path = archive_dir / txt_name
                    #             if fsub:
                    #                 pot_txt = archive_dir / fsub / txt_name
                    #                 if pot_txt.exists():
                    #                     txt_path = pot_txt
                    #             
                    #             if txt_path.exists():
                    #                 txt_backup_name = f"{txt_name}.backup.{timestamp}"
                    #                 txt_backup_path = backup_dir / txt_backup_name
                    #                 shutil.copy2(str(txt_path), str(txt_backup_path))
                    #                 LOGGER.info(f"[PHG] Backed up prompt {txt_path} to {txt_backup_path}")
                    #     except Exception as e:
                    #         LOGGER.error(f"[PHG] Backup failed: {e}")
                    
                    _delete_file_safely(arch_path)
                    
                    if archive_prompts_enabled:
                        txt_name = f"{Path(fname).stem}.txt"
                        txt_path = archive_dir / txt_name
                        if fsub:
                            pot_txt = archive_dir / fsub / txt_name
                            if pot_txt.exists():
                                txt_path = pot_txt
                        _delete_file_safely(txt_path)

                # 2. Удаляем запись из БД
                # Удаляем по entry_id (который у всех в пачке один) и filename
                cursor.execute("""
                    DELETE FROM prompt_history_output 
                    WHERE entry_id = ? AND filename = ?
                """, (main_entry_id, fname))
                
                if cursor.rowcount > 0:
                    deleted_count += 1
                    LOGGER.debug(f"[PHG] Deleted DB record for {fname}")

            # Проверяем, не удалили ли мы всё случайно (должно остаться 1)
            cursor.execute("SELECT COUNT(*) FROM prompt_history_output WHERE entry_id = ?", (main_entry_id,))
            count = cursor.fetchone()[0]
            
            prompt_deleted = False
            if count == 0:
                # Это аварийная ситуация, так как мы должны были оставить 1 файл
                LOGGER.warning(f"[PHG] All images deleted for {main_entry_id}, removing prompt entry.")
                cursor.execute("DELETE FROM prompt_history WHERE id = ?", (main_entry_id,))
                prompt_deleted = True
            
            db.commit()
            
            # Уведомляем фронтенд
            _notify_history_update(server)
            
            return web.json_response({
                "success": True,
                "message": f"Deleted {deleted_count} images from archive and history",
                "deleted_count": deleted_count,
                "prompt_deleted": prompt_deleted
            })

        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Critical error in delete_others: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # ==========================================================
    # ЭНДПОИНТ: Undo delete (восстановление из backup)
    # ==========================================================
    async def undo_delete_route(request):
        """
        Restore the last deleted image from backup folder.
        Looks in archive/backup for the most recently backed up file.
        """
        db = None
        try:
            db = _get_db_connection()
            cursor = db.cursor()
            output_dir = _get_output_directory()
            
            archive_settings = get_archive_settings()
            archive_enabled = archive_settings.get("enabled", False)
            archive_folder = archive_settings.get("folder_name", "archive")
            
            if not archive_enabled:
                return web.json_response(
                    {"success": False, "error": "Archive is not enabled"},
                    status=400
                )
            
            archive_dir = output_dir / archive_folder
            backup_dir = archive_dir / "backup"
            
            if not backup_dir.exists():
                return web.json_response(
                    {"success": False, "error": "No backup directory found"},
                    status=404
                )
            
            # Find the most recent backup file
            backup_files = list(backup_dir.glob("*"))
            if not backup_files:
                return web.json_response(
                    {"success": False, "error": "No files in backup"},
                    status=404
                )
            
            # Sort by modification time, most recent first
            backup_files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
            latest_backup = backup_files[0]
            
            LOGGER.info(f"[PHG] UNDO: Restoring {latest_backup.name}")
            
            # Determine original filename (remove .backup timestamp suffix if present)
            original_filename = latest_backup.name
            if ".backup." in original_filename:
                original_filename = original_filename.split(".backup.")[0]
            
            # Move file from backup back to archive
            restore_path = archive_dir / original_filename
            
            # Check if file already exists at restore location
            if restore_path.exists():
                return web.json_response(
                    {"success": False, "error": "File already exists at restore location"},
                    status=400
                )
            
            # Move the file
            import shutil
            shutil.move(str(latest_backup), str(restore_path))
            
            # Also check for associated prompt file
            prompt_backup = backup_dir / f"{Path(original_filename).stem}.txt.backup.{latest_backup.stat().st_mtime}"
            if not prompt_backup.exists():
                # Try alternative naming
                prompt_backup = latest_backup.with_suffix('.txt')
                if not prompt_backup.exists():
                    prompt_backup = None
            
            if prompt_backup and prompt_backup.exists():
                prompt_restore_path = archive_dir / f"{Path(original_filename).stem}.txt"
                if not prompt_restore_path.exists():
                    shutil.move(str(prompt_backup), str(prompt_restore_path))
            
            # Re-insert into database
            # We need to find or create the entry_id
            # For simplicity, we'll create a new entry or use a placeholder
            cursor.execute("""
                SELECT id FROM prompt_history 
                WHERE filename LIKE ? 
                ORDER BY created_at DESC LIMIT 1
            """, (f"%{original_filename}",))
            result = cursor.fetchone()
            
            if result:
                entry_id = result[0]
            else:
                # Create a minimal entry
                cursor.execute("""
                    INSERT INTO prompt_history (prompt, negative_prompt, created_at)
                    VALUES ('Restored from backup', '', datetime('now'))
                """)
                entry_id = cursor.lastrowid
            
            # Insert output record
            cursor.execute("""
                INSERT INTO prompt_history_output (entry_id, filename, subfolder, type)
                VALUES (?, ?, '', 'output')
            """, (entry_id, original_filename))
            
            db.commit()
            
            # Notify frontend
            _notify_history_update(server)
            
            return web.json_response({
                "success": True,
                "message": f"Restored {original_filename}",
                "filename": original_filename,
                "entry_id": entry_id
            })
            
        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Critical error in undo_delete: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # ==========================================================
    # ЭНДПОИНТ: Удаление всей записи истории (пачки изображений)
    # ==========================================================
    async def delete_history_entry_route(request):
        """Delete an entire history entry and all associated files from archive."""
        db = None
        try:
            data = await request.json()
            entry_id = data.get("entry_id")
            
            LOGGER.info(f"[PHG] DELETE ENTRY: Entry={entry_id}")
            
            if not entry_id:
                return web.json_response(
                    {"success": False, "error": "Missing entry_id"}, 
                    status=400
                )
            
            # Используем singleton storage для консистентности
            from .storage import get_prompt_history_storage
            storage = get_prompt_history_storage()
            
            LOGGER.info(f"[PHG] Using storage instance: {id(storage)}, DB file: {storage._file_path}")
            
            # Проверяем настройки архива перед удалением
            from .archiver import get_archive_settings
            archive_settings = get_archive_settings()
            LOGGER.info(f"[PHG] Archive settings before delete: {archive_settings}")
            
            result = storage.delete(entry_id)
            
            if result:
                LOGGER.info(f"[PHG] Successfully deleted entry {entry_id} and associated files")
                # Notify frontend
                _notify_history_update(server)
                return web.json_response({
                    "success": True,
                    "message": "Entry and all associated files deleted"
                })
            else:
                LOGGER.warning(f"[PHG] Entry {entry_id} not found or already deleted")
                return web.json_response(
                    {"success": False, "error": "Entry not found"}, 
                    status=404
                )
            
        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Critical error in delete_history_entry: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # ==========================================================
    # ЭНДПОИНТ: Синхронизация WAL файла с основной базой
    # ==========================================================
    async def sync_wal_to_db_route(request):
        """Force WAL checkpoint to sync data to main database file."""
        try:
            from .storage import get_prompt_history_storage
            storage = get_prompt_history_storage()
            
            LOGGER.info(f"[PHG] Manual WAL sync requested, DB file: {storage._file_path}")
            
            # Выполняем checkpoint для переноса данных из WAL в основную БД
            # Используем прямое выполнение без контекстного менеджера
            with storage._lock:
                cursor = storage._connection.cursor()
                cursor.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                checkpoint_result = cursor.fetchone()
                LOGGER.info(f"[PHG] WAL checkpoint completed: {checkpoint_result}")
            
            # Проверяем размер файлов после синхронизации
            db_file = storage._file_path
            wal_file = storage._file_path.with_suffix(storage._file_path.suffix + "-wal")
            
            db_size = db_file.stat().st_size if db_file.exists() else 0
            wal_size = wal_file.stat().st_size if wal_file.exists() else 0
            
            LOGGER.info(f"[PHG] DB file size: {db_size} bytes, WAL file size: {wal_size} bytes")
            
            _notify_history_update(server)
            
            return web.json_response({
                "success": True,
                "message": "WAL synchronized to database",
                "db_size": db_size,
                "wal_size": wal_size
            })
            
        except Exception as e:
            LOGGER.error(f"[PHG] Error during WAL sync: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    async def import_archive_metadata_route(request):
        """Extract metadata from archive images and update database records."""
        db = None
        try:
            from .storage import get_prompt_history_storage
            
            # Get archive directory
            output_dir = _get_output_directory()
            archive_settings = get_archive_settings()
            archive_folder = archive_settings.get("folder_name", "archive")
            archive_dir = output_dir / archive_folder
            
            if not archive_dir or not archive_dir.exists():
                return web.json_response({
                    "success": False,
                    "error": f"Archive directory not found: {archive_dir}"
                }, status=400)
            
            LOGGER.info(f"[PHG] Extracting metadata from archive: {archive_dir}")
            
            # Extract metadata from all PNG files in archive
            metadata_map = extract_metadata_from_archive_images(archive_dir)
            LOGGER.info(f"[PHG] Extracted metadata from {len(metadata_map)} images")
            
            if not metadata_map:
                return web.json_response({
                    "success": True,
                    "message": "No metadata found in archive images.",
                    "processed_count": 0
                })
            
            # Get DB connection for direct update
            db = _get_db_connection()
            cursor = db.cursor()
            
            updated_count = 0
            no_metadata_count = 0
            
            # Iterate through metadata map and update DB directly
            for filename, raw_metadata in metadata_map.items():
                normalized = normalize_extracted_metadata(raw_metadata)
                
                if not normalized:
                    no_metadata_count += 1
                    continue
                
                # Convert to JSON string for storage
                metadata_json = json.dumps(normalized)
                
                # Try to find the entry_id by matching filename in prompt_history_output
                # We check both exact match and match within subfolder
                cursor.execute("""
                    SELECT entry_id FROM prompt_history_output 
                    WHERE filename = ? OR filename LIKE ?
                """, (filename, f"%/{filename}"))
                
                result = cursor.fetchone()
                
                if result:
                    entry_id = result[0]
                    
                    # Update the metadata column
                    cursor.execute("""
                        UPDATE prompt_history_output 
                        SET metadata = ? 
                        WHERE entry_id = ? AND (filename = ? OR filename LIKE ?)
                    """, (metadata_json, entry_id, filename, f"%/{filename}"))
                    
                    if cursor.rowcount > 0:
                        updated_count += 1
                        LOGGER.info(f"[PHG] Updated metadata for {filename} (Entry ID: {entry_id})")
                    else:
                        LOGGER.warning(f"[PHG] No rows updated for {filename} (Entry ID: {entry_id})")
                else:
                    LOGGER.warning(f"[PHG] No database entry found for file: {filename}")
            
            db.commit()
            _notify_history_update(server)
            
            result_msg = f"Updated {updated_count} entries with metadata from archive"
            if no_metadata_count > 0:
                result_msg += f" ({no_metadata_count} files had no usable metadata)"
            
            return web.json_response({
                "success": True,
                "message": result_msg,
                "processed_count": len(metadata_map),
                "updated_count": updated_count,
                "no_metadata_count": no_metadata_count
            })
            
        except Exception as e:
            if db:
                try:
                    db.rollback()
                except:
                    pass
            LOGGER.error(f"[PHG] Error importing archive metadata: {e}", exc_info=True)
            return web.json_response({"success": False, "error": str(e)}, status=500)

    # Register routes
    server.app.router.add_get("/api/prompt-history-gallery/archive-settings", get_archive_settings_route)
    server.app.router.add_post("/api/prompt-history-gallery/archive-settings", update_archive_settings_route)
    server.app.router.add_post("/api/prompt-history-gallery/create-archive-folder", create_archive_folder_route)
    server.app.router.add_post("/api/phg/sync_wal_to_db", sync_wal_to_db_route)
    
    server.app.router.add_post("/api/phg/delete_history_entry", delete_history_entry_route)
    server.app.router.add_post("/api/phg/delete_image_from_history", delete_image_from_history_route)
    server.app.router.add_post("/api/phg/delete_image_everywhere", delete_image_everywhere_route)
    server.app.router.add_post("/api/phg/delete_others_except_selected", delete_others_except_selected_route)
    server.app.router.add_post("/api/phg/undo_delete", undo_delete_route)
    
    # Route for importing metadata from archive images
    server.app.router.add_post("/api/phg/import_archive_metadata", import_archive_metadata_route)
    
    LOGGER.info("[PHG] Routes registered successfully")