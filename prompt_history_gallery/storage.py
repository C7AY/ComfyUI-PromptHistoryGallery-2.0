"""
Helpers for persisting prompt history entries using SQLite.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple, TypeVar

LOGGER = logging.getLogger(__name__)

from .models import PromptHistoryEntry
from .normalizers import normalize_metadata, normalize_output_payload
from .serialization import deserialize_metadata, serialize_metadata
# Импортируем функции для работы с метаданными изображений
from .metadata_extractor import _extract_metadata_from_png, normalize_extracted_metadata


def _default_storage_directory() -> Path:
    base_dir = os.environ.get("COMFYUI_PROMPT_HISTORY_DIR")
    if base_dir:
        return Path(base_dir).expanduser()
    return Path(__file__).resolve().parent / "data"


def _ensure_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


T = TypeVar("T")


def _chunked(values: Sequence[T], chunk_size: int) -> Iterator[Sequence[T]]:
    for idx in range(0, len(values), chunk_size):
        yield values[idx : idx + chunk_size]


class PromptHistoryStorage:
    _FALLBACK_LOOKUP_LIMIT = 25

    def __init__(self, storage_file: Optional[Path] = None) -> None:
        if storage_file is None:
            storage_file = _default_storage_directory() / "prompt_history.db"
        self._file_path = storage_file
        _ensure_directory(self._file_path.parent)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(self._file_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON;")
        self._configure_database()
        self._sync_wal_on_startup()

    @contextmanager
    def _locked_cursor(self, *, commit: bool = False) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cursor = self._connection.cursor()
            try:
                yield cursor
                if commit:
                    self._connection.commit()
            except Exception:
                if commit:
                    self._connection.rollback()
                raise

    def _create_entry_locked(
        self,
        cursor: sqlite3.Cursor,
        prompt: str,
        metadata: Dict[str, Any],
        negative_prompt: str = "",
    ) -> PromptHistoryEntry:
        now_iso = datetime.now(timezone.utc).isoformat()
        entry = PromptHistoryEntry(
            id=str(uuid.uuid4()),
            created_at=now_iso,
            last_used_at=now_iso,
            prompt=prompt,
            negative_prompt=negative_prompt,
            metadata=metadata.copy(),
            files=tuple(),
        )
        cursor.execute(
            """
            INSERT INTO prompt_history (id, created_at, last_used_at, prompt, negative_prompt, tags, metadata)
            VALUES (:id, :created_at, :last_used_at, :prompt, :negative_prompt, :tags, :metadata)
            """,
            {
                "id": entry.id,
                "created_at": entry.created_at,
                "last_used_at": entry.last_used_at,
                "prompt": entry.prompt,
                "negative_prompt": entry.negative_prompt,
                "tags": "[]",
                "metadata": serialize_metadata(entry.metadata),
            },
        )
        return entry

    def _find_entry_locked(
        self,
        cursor: sqlite3.Cursor,
        prompt: str,
        negative_prompt: str,
        metadata: Dict[str, Any],
    ) -> Optional[PromptHistoryEntry]:
        payload = {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "metadata": serialize_metadata(metadata),
        }
        row = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, COALESCE(negative_prompt, '') as negative_prompt, metadata
            FROM prompt_history
            WHERE prompt = :prompt AND COALESCE(negative_prompt, '') = :negative_prompt AND metadata = :metadata
            ORDER BY last_used_at DESC
            LIMIT 1
            """,
            payload,
        ).fetchone()
        if row is not None:
            return PromptHistoryEntry.from_row(row)

        fallback_rows = cursor.execute(
            """
            SELECT id, created_at, last_used_at, prompt, COALESCE(negative_prompt, '') as negative_prompt, metadata
            FROM prompt_history
            WHERE prompt = ?
            ORDER BY last_used_at DESC, created_at DESC
            LIMIT ?
            """,
            (prompt, self._FALLBACK_LOOKUP_LIMIT),
        ).fetchall()

        for candidate_row in fallback_rows:
            candidate_entry = PromptHistoryEntry.from_row(candidate_row)
            if candidate_entry.metadata == metadata and candidate_entry.negative_prompt == negative_prompt:
                return candidate_entry

        return None

    def append(
        self,
        prompt: str,
        *,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> PromptHistoryEntry:
        incoming_metadata = normalize_metadata(metadata)
        with self._locked_cursor(commit=True) as cursor:
            entry = self._create_entry_locked(cursor, prompt, incoming_metadata, negative_prompt)
        return entry

    def ensure_entry(
        self,
        prompt: str,
        *,
        negative_prompt: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Tuple[PromptHistoryEntry, bool]:
        incoming_metadata = normalize_metadata(metadata)
        with self._locked_cursor(commit=True) as cursor:
            existing = self._find_entry_locked(cursor, prompt, negative_prompt, incoming_metadata)
            if existing is not None:
                return existing, False
            entry = self._create_entry_locked(cursor, prompt, incoming_metadata, negative_prompt)
            return entry, True

    def update_metadata(self, entry_id: str, metadata_update: Dict[str, Any]) -> None:
        if not entry_id or not metadata_update:
            return

        with self._locked_cursor(commit=True) as cursor:
            row = cursor.execute(
                "SELECT metadata FROM prompt_history WHERE id = ?", (entry_id,)
            ).fetchone()
            if not row:
                return

            current_metadata = deserialize_metadata(row["metadata"])
            changed = False
            for k, v in metadata_update.items():
                if current_metadata.get(k) != v:
                    current_metadata[k] = v
                    changed = True

            if changed:
                cursor.execute(
                    "UPDATE prompt_history SET metadata = ? WHERE id = ?",
                    (serialize_metadata(current_metadata), entry_id),
                )

    def list(self, limit: Optional[int] = None) -> List[PromptHistoryEntry]:
        sql = (
            "SELECT id, created_at, last_used_at, prompt, COALESCE(negative_prompt, '') as negative_prompt, metadata "
            "FROM ("
            "SELECT id, created_at, last_used_at, prompt, COALESCE(negative_prompt, '') as negative_prompt, metadata, "
            "ROW_NUMBER() OVER ("
            "PARTITION BY prompt, COALESCE(negative_prompt, '') "
            "ORDER BY last_used_at DESC, created_at DESC, id DESC"
            ") AS row_rank "
            "FROM prompt_history"
            ") "
            "WHERE row_rank = 1 "
            "ORDER BY last_used_at DESC, created_at DESC"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params = (limit,)
        else:
            params = ()
        with self._locked_cursor() as cursor:
            rows = cursor.execute(sql, params).fetchall()
            prompts = [row["prompt"] for row in rows]
            outputs_map = self._fetch_outputs_by_prompt(cursor, prompts) if prompts else {}
            entry_ids = {
                record.get("entry_id")
                for records in outputs_map.values()
                for record in records
                if isinstance(record, dict) and record.get("entry_id")
            }
            metadata_map = (
                self._fetch_metadata_by_entry_ids(cursor, sorted(entry_ids)) if entry_ids else {}
            )
        entries: List[PromptHistoryEntry] = []
        for row in rows:
            files = tuple(outputs_map.get(row["prompt"], []))
            entry = PromptHistoryEntry.from_row(row, files)
            if metadata_map and files:
                prompt_entry_ids = {
                    record.get("entry_id")
                    for record in files
                    if isinstance(record, dict) and record.get("entry_id")
                }
                if prompt_entry_ids:
                    entry.metadata["_phg_entry_metadata"] = {
                        entry_id: metadata_map[entry_id]
                        for entry_id in prompt_entry_ids
                        if entry_id in metadata_map
                    }
            entries.append(entry)
        return entries

    def add_outputs_for_entries(
        self,
        entry_ids: Sequence[str],
        files: Sequence[Any],
    ) -> None:
        normalized: List[OutputRecord] = []
        for file_info in files:
            payload = normalize_output_payload(file_info)
            if payload:
                normalized.append(payload)

        if not normalized:
            return

        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return

        # Получаем путь к output директории для извлечения метаданных
        try:
            from folder_paths import get_output_directory
            output_dir = Path(get_output_directory())
        except Exception:
            output_dir = Path(__file__).resolve().parent.parent.parent / "output"

        with self._locked_cursor(commit=True) as cursor:
            for entry_id in targets:
                for item in normalized:
                    cursor.execute(
                        """
                        INSERT OR IGNORE INTO prompt_history_output
                            (entry_id, filename, subfolder, type)
                        VALUES
                            (:entry_id, :filename, :subfolder, :type)
                        """,
                        {
                            "entry_id": entry_id,
                            "filename": item.filename,
                            "subfolder": item.subfolder,
                            "type": item.type,
                        },
                    )
                    
                    # <--- ИЗМЕНЕНИЕ: Извлекаем и сохраняем метаданные сразу при добавлении
                    # Сначала пробуем извлечь из output директории (файл может уже существовать)
                    metadata_extracted = self._extract_and_save_metadata(cursor, entry_id, item.filename, item.subfolder, output_dir)
                    
                    # Если не удалось извлечь из output, пробуем из архива (если архивирование включено)
                    if not metadata_extracted:
                        try:
                            from .archiver import get_archive_settings
                            archive_settings = get_archive_settings()
                            if archive_settings.get("enabled", False):
                                archive_folder = archive_settings.get("folder_name", "archive")
                                archive_dir = output_dir / archive_folder
                                if archive_dir.exists():
                                    self._extract_and_save_metadata(cursor, entry_id, item.filename, item.subfolder, archive_dir)
                        except Exception as e:
                            LOGGER.debug(f"[PHG] Could not check archive for metadata: {e}")

    def _extract_and_save_metadata(
        self, 
        cursor: sqlite3.Cursor, 
        entry_id: str, 
        filename: str, 
        subfolder: str, 
        output_dir: Path
    ) -> bool:
        """Извлекает метаданные из файла и обновляет запись в БД. Возвращает True при успехе."""
        # Определяем полный путь к файлу
        file_path = output_dir / filename
        if subfolder:
            sub_path = output_dir / subfolder / filename
            if sub_path.exists():
                file_path = sub_path
        
        if not file_path.exists():
            LOGGER.debug(f"[PHG] File not found for metadata extraction: {file_path}")
            return False

        try:
            # Используем существующую функцию извлечения
            raw_metadata = _extract_metadata_from_png(file_path)
            if raw_metadata:
                normalized = normalize_extracted_metadata(raw_metadata)
                if normalized:
                    cursor.execute(
                        "UPDATE prompt_history_output SET metadata = ? WHERE entry_id = ? AND filename = ? AND COALESCE(subfolder, '') = ?",
                        (serialize_metadata(normalized), entry_id, filename, subfolder or "")
                    )
                    LOGGER.info(f"[PHG] Auto-saved metadata for {filename}: {list(normalized.keys())}")
                    return True
                else:
                    LOGGER.debug(f"[PHG] No normalized metadata for {filename}")
            else:
                LOGGER.debug(f"[PHG] No raw metadata extracted from {filename}")
        except Exception as e:
            LOGGER.warning(f"[PHG] Failed to extract metadata for {filename}: {e}", exc_info=True)
        
        return False

    def touch_entries(self, entry_ids: Sequence[str]) -> None:
        targets = [str(entry_id) for entry_id in entry_ids if entry_id]
        if not targets:
            return
        timestamp = datetime.now(timezone.utc).isoformat()
        with self._locked_cursor(commit=True) as cursor:
            cursor.executemany(
                "UPDATE prompt_history SET last_used_at = ? WHERE id = ?",
                [(timestamp, entry_id) for entry_id in targets],
            )

    def find_entry_id_for_prompt_and_negative(self, prompt: str, negative_prompt: str) -> Optional[str]:
        if not prompt:
            return None
        
        with self._locked_cursor() as cursor:
            row = cursor.execute(
                """
                SELECT id FROM prompt_history 
                WHERE prompt = ? AND COALESCE(negative_prompt, '') = ?
                ORDER BY last_used_at DESC, created_at DESC
                LIMIT 1
                """,
                (prompt, negative_prompt),
            ).fetchone()
            
            if row:
                return row["id"]
            
            if not negative_prompt:
                row = cursor.execute(
                    """
                    SELECT id FROM prompt_history 
                    WHERE prompt = ?
                    ORDER BY last_used_at DESC, created_at DESC
                    LIMIT 1
                    """,
                    (prompt,),
                ).fetchone()
                if row:
                    return row["id"]
        
        return None

    def find_entry_ids_for_prompts(self, prompts: Sequence[str]) -> Dict[str, str]:
        candidates = [str(p) for p in prompts if isinstance(p, str) and p]
        if not candidates:
            return {}

        placeholders = ",".join(["?"] * len(candidates))
        sql = (
            "SELECT prompt, id FROM prompt_history WHERE prompt IN ("
            + placeholders
            + ") ORDER BY last_used_at DESC, created_at DESC"
        )

        with self._locked_cursor() as cursor:
            rows = cursor.execute(sql, tuple(candidates)).fetchall()

        mapping: Dict[str, str] = {}
        for row in rows:
            prompt = row["prompt"]
            if prompt not in mapping:
                mapping[prompt] = row["id"]

        return mapping

    def _fetch_outputs_by_prompt(
        self, cursor: sqlite3.Cursor, prompts: Sequence[str]
    ) -> Dict[str, List[Dict[str, Any]]]:
        if not prompts:
            return {}

        outputs: Dict[str, List[Dict[str, Any]]] = {prompt: [] for prompt in prompts}
        chunk_size = 900

        for chunk in _chunked(prompts, chunk_size):
            placeholders = ",".join(["?"] * len(chunk))
            sql = (
                "SELECT p.prompt, o.entry_id, o.filename, o.subfolder, o.type, o.metadata as output_metadata, h.metadata as prompt_metadata "
                "FROM prompt_history_output o "
                "JOIN prompt_history p ON p.id = o.entry_id "
                "JOIN prompt_history h ON h.id = o.entry_id "
                f"WHERE p.prompt IN ({placeholders}) ORDER BY o.id"
            )
            rows = cursor.execute(sql, tuple(chunk)).fetchall()
            for row in rows:
                prompt = row["prompt"]
                output_metadata = deserialize_metadata(row["output_metadata"])
                prompt_metadata = deserialize_metadata(row["prompt_metadata"])
                
                # Приоритет: metadata из prompt_history_output, иначе из prompt_history
                if output_metadata and isinstance(output_metadata, dict) and len(output_metadata) > 0:
                    metadata = output_metadata
                elif prompt_metadata and isinstance(prompt_metadata, dict):
                    metadata = prompt_metadata
                else:
                    metadata = {}
                
                record: Dict[str, Any] = {
                    "filename": row["filename"],
                    "entry_id": row["entry_id"],
                    "metadata": metadata,
                }
                if row["subfolder"]:
                    record["subfolder"] = row["subfolder"]
                if row["type"]:
                    record["type"] = row["type"]
                
                outputs.setdefault(prompt, []).append(record)

        return outputs

    def _fetch_metadata_by_entry_ids(
        self, cursor: sqlite3.Cursor, entry_ids: Sequence[str]
    ) -> Dict[str, Dict[str, Any]]:
        if not entry_ids:
            return {}

        metadata_map: Dict[str, Dict[str, Any]] = {}
        chunk_size = 900

        for chunk in _chunked(entry_ids, chunk_size):
            placeholders = ",".join(["?"] * len(chunk))
            sql = f"SELECT id, metadata FROM prompt_history WHERE id IN ({placeholders})"
            rows = cursor.execute(sql, tuple(chunk)).fetchall()
            for row in rows:
                metadata_map[row["id"]] = deserialize_metadata(row["metadata"])

        return metadata_map

    def delete(self, entry_id: str) -> bool:
        LOGGER.info(f"[PHG] DELETE called with entry_id: {entry_id}")
        LOGGER.info(f"[PHG] Storage DB file: {self._file_path}, exists: {self._file_path.exists()}")
        
        try:
            self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            LOGGER.info("[PHG] WAL checkpoint completed")
        except Exception as e:
            LOGGER.warning(f"[PHG] WAL checkpoint failed: {e}")
        
        with self._locked_cursor(commit=True) as cursor:
            row = cursor.execute(
                "SELECT prompt FROM prompt_history WHERE id = ?", (entry_id,)
            ).fetchone()
            if not row:
                LOGGER.warning(f"[PHG] Entry {entry_id} not found in database")
                all_entries = cursor.execute("SELECT id, prompt FROM prompt_history").fetchall()
                LOGGER.info(f"[PHG] All entries in DB: {[(r['id'], r['prompt']) for r in all_entries]}")
                return False
            
            prompt_text = row["prompt"]
            LOGGER.info(f"[PHG] Deleting entry {entry_id} with prompt: {prompt_text[:100]}...")
            
            output_rows = cursor.execute(
                "SELECT filename, subfolder, type FROM prompt_history_output WHERE entry_id = ?", 
                (entry_id,)
            ).fetchall()
            
            LOGGER.info(f"[PHG] Found {len(output_rows)} output files to delete from archive")
            
            cursor.execute("DELETE FROM prompt_history WHERE prompt = ?", (prompt_text,))
            db_deleted = cursor.rowcount > 0
            
            if db_deleted:
                LOGGER.info(f"[PHG] Deleted {cursor.rowcount} entry(s) from database")
            
            self._connection.commit()
            
            try:
                self._connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except Exception as e:
                LOGGER.warning(f"[PHG] Post-delete WAL checkpoint failed: {e}")
            
            if output_rows:
                LOGGER.info(f"[PHG] Calling _delete_archive_files for {len(output_rows)} files")
                self._delete_archive_files(output_rows)
            else:
                LOGGER.warning(f"[PHG] No output files found for entry {entry_id}")
            
            return db_deleted
    
    def _delete_archive_files(self, output_rows: List[Any]) -> None:
        try:
            from .archiver import get_archive_settings, _get_comfyui_output_dir
            
            archive_settings = get_archive_settings()
            LOGGER.info(f"[PHG] Archive settings during delete: {archive_settings}")
            
            if not archive_settings.get("enabled", False):
                LOGGER.warning("[PHG] Archive is disabled, skipping file deletion")
                return
            
            archive_folder = archive_settings.get("folder_name", "archive")
            output_dir = _get_comfyui_output_dir()
            
            LOGGER.info(f"[PHG] ComfyUI output directory: {output_dir}")
            
            if not output_dir:
                LOGGER.error("[PHG] Could not determine ComfyUI output directory")
                return
            
            archive_dir = output_dir / archive_folder
            LOGGER.info(f"[PHG] Archive directory: {archive_dir}, exists: {archive_dir.exists()}")
            
            if not archive_dir.exists():
                LOGGER.warning(f"[PHG] Archive directory does not exist: {archive_dir}")
                if output_dir.exists():
                    LOGGER.info(f"[PHG] Contents of output dir: {list(output_dir.iterdir())}")
                return
            
            deleted_count = 0
            for row in output_rows:
                filename = row["filename"]
                subfolder = row.get("subfolder", "")
                
                LOGGER.info(f"[PHG] Processing file for deletion: {filename} (subfolder: {subfolder})")
                
                archive_file_path = archive_dir / filename
                if subfolder:
                    sub_archive_path = archive_dir / subfolder / filename
                    if sub_archive_path.exists():
                        archive_file_path = sub_archive_path
                
                LOGGER.info(f"[PHG] Checking archive file path: {archive_file_path}, exists: {archive_file_path.exists()}")
                if archive_file_path.exists():
                    try:
                        archive_file_path.unlink()
                        LOGGER.info(f"[PHG] Deleted archived file: {archive_file_path}")
                        deleted_count += 1
                    except Exception as e:
                        LOGGER.error(f"[PHG] Error deleting archived file {archive_file_path}: {e}")
                else:
                    LOGGER.warning(f"[PHG] Archived file not found: {archive_file_path}")
                    if archive_dir.exists():
                        archive_files = list(archive_dir.iterdir())
                        LOGGER.info(f"[PHG] Files in archive dir: {[f.name for f in archive_files[:20]]}")
                
                base_name = filename.rsplit('.', 1)[0] if '.' in filename else filename
                txt_filename = f"{base_name}.txt"
                txt_path = archive_dir / txt_filename
                if subfolder:
                    sub_txt_path = archive_dir / subfolder / txt_filename
                    if sub_txt_path.exists():
                        txt_path = sub_txt_path
                
                if txt_path.exists():
                    try:
                        txt_path.unlink()
                        LOGGER.info(f"[PHG] Deleted archived prompt file: {txt_path}")
                    except Exception as e:
                        LOGGER.error(f"[PHG] Error deleting archived prompt file {txt_path}: {e}")
            
            LOGGER.info(f"[PHG] Successfully deleted {deleted_count}/{len(output_rows)} archived files")
        except Exception as e:
            LOGGER.error(f"[PHG] Error during archive file deletion: {e}", exc_info=True)

    def delete_output_file(self, entry_id: str, filename: str, subfolder: str = "", file_type: str = "") -> bool:
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute(
                "DELETE FROM prompt_history_output WHERE entry_id = ? AND filename = ? AND COALESCE(subfolder, '') = ? AND COALESCE(type, '') = ?",
                (entry_id, filename, subfolder, file_type),
            )
            return cursor.rowcount > 0

    def delete_output(self, entry_id: str, filename: str, subfolder: str = "", file_type: str = "") -> bool:
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute(
                "DELETE FROM prompt_history_output WHERE entry_id = ? AND filename = ? AND COALESCE(subfolder, '') = ? AND COALESCE(type, '') = ?",
                (entry_id, filename, subfolder, file_type),
            )
            return cursor.rowcount > 0

    def delete_outputs_except(self, entry_id: str, keep_filename: str, keep_subfolder: str = "", keep_type: str = "") -> int:
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute(
                "DELETE FROM prompt_history_output WHERE entry_id = ? AND NOT (filename = ? AND COALESCE(subfolder, '') = ? AND COALESCE(type, '') = ?)",
                (entry_id, keep_filename, keep_subfolder, keep_type),
            )
            return cursor.rowcount

    def get_outputs_for_entry(self, entry_id: str) -> List[Dict[str, str]]:
        with self._locked_cursor() as cursor:
            rows = cursor.execute(
                "SELECT filename, subfolder, type FROM prompt_history_output WHERE entry_id = ?",
                (entry_id,),
            ).fetchall()
            return [
                {"filename": row["filename"], "subfolder": row["subfolder"], "type": row["type"]}
                for row in rows
            ]

    def get_output_count_for_entry(self, entry_id: str) -> int:
        with self._locked_cursor() as cursor:
            row = cursor.execute(
                "SELECT COUNT(*) as count FROM prompt_history_output WHERE entry_id = ?",
                (entry_id,),
            ).fetchone()
            return row["count"] if row else 0

    def clear(self) -> None:
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute("DELETE FROM prompt_history_output")
            cursor.execute("DELETE FROM prompt_history")

    def _configure_database(self) -> None:
        with self._locked_cursor(commit=True) as cursor:
            cursor.execute("PRAGMA journal_mode=WAL;")
            cursor.execute("PRAGMA synchronous=NORMAL;")
            
            table_exists = cursor.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_history'"
            ).fetchone() is not None
            
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_history (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    last_used_at TEXT NOT NULL,
                    prompt TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    metadata TEXT NOT NULL,
                    negative_prompt TEXT DEFAULT ''
                )
                """
            )
            
            existing_columns = {
                row["name"] for row in cursor.execute("PRAGMA table_info(prompt_history)")
            }
            
            if "last_used_at" not in existing_columns:
                cursor.execute("ALTER TABLE prompt_history ADD COLUMN last_used_at TEXT")
                cursor.execute(
                    """
                    UPDATE prompt_history
                    SET last_used_at = COALESCE(last_used_at, created_at)
                    """
                )
            
            if "negative_prompt" not in existing_columns:
                cursor.execute("ALTER TABLE prompt_history ADD COLUMN negative_prompt TEXT DEFAULT ''")
                cursor.execute(
                    """
                    UPDATE prompt_history
                    SET negative_prompt = COALESCE(negative_prompt, '')
                    """
                )
            
            cursor.execute(
                """
                UPDATE prompt_history
                SET metadata = '{}'
                WHERE metadata IS NULL OR metadata = ''
                """
            )
            
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS prompt_history_output (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entry_id TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    subfolder TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL DEFAULT '',
                    metadata TEXT DEFAULT '{}',
                    UNIQUE(entry_id, filename, subfolder, type),
                    FOREIGN KEY(entry_id) REFERENCES prompt_history(id) ON DELETE CASCADE
                )
                """
            )
            
            output_columns = {
                row["name"] for row in cursor.execute("PRAGMA table_info(prompt_history_output)")
            }
            
            if "metadata" not in output_columns:
                LOGGER.info("[PHG] Adding metadata column to prompt_history_output table")
                cursor.execute("ALTER TABLE prompt_history_output ADD COLUMN metadata TEXT DEFAULT '{}'")
                
                try:
                    self._import_metadata_from_archive(cursor)
                except Exception as e:
                    LOGGER.warning(f"[PHG] Automatic metadata import failed: {e}")
            
            cursor.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_prompt_history_output_entry
                ON prompt_history_output (entry_id)
                """
            )
            cursor.execute("DROP INDEX IF EXISTS idx_prompt_history_prompt_unique")

    def _import_metadata_from_archive(self, cursor: sqlite3.Cursor) -> None:
        try:
            from .archiver import get_archive_settings
            from .metadata_extractor import extract_metadata_from_archive_images
            
            try:
                from folder_paths import get_output_directory
                output_dir = Path(get_output_directory())
            except Exception:
                output_dir = Path(__file__).resolve().parent.parent.parent / "output"
            
            archive_settings = get_archive_settings()
            archive_folder = archive_settings.get("folder_name", "archive")
            archive_dir = output_dir / archive_folder
            
            if not archive_dir.exists():
                LOGGER.info(f"[PHG] Archive directory not found: {archive_dir}, skipping metadata import")
                return
            
            LOGGER.info(f"[PHG] Importing metadata from archive: {archive_dir}")
            
            metadata_map = extract_metadata_from_archive_images(archive_dir)
            LOGGER.info(f"[PHG] Extracted metadata from {len(metadata_map)} images")
            
            if not metadata_map:
                LOGGER.info("[PHG] No metadata found in archive images")
                return
            
            # <--- ИЗМЕНЕНИЕ: Исправлен запрос для обновления prompt_history_output
            cursor.execute("""
                SELECT ph.id, pho.filename, pho.subfolder
                FROM prompt_history_output pho
                JOIN prompt_history ph ON ph.id = pho.entry_id
            """)
            
            rows = cursor.fetchall()
            updated_count = 0
            
            for row in rows:
                entry_id = row["id"]
                filename = row["filename"]
                subfolder = row["subfolder"] or ""
                
                if subfolder:
                    key = f"{subfolder}/{filename}"
                else:
                    key = filename
                
                raw_metadata = None
                if key in metadata_map:
                    raw_metadata = metadata_map[key]
                elif filename in metadata_map:
                    raw_metadata = metadata_map[filename]
                
                if raw_metadata:
                    normalized = normalize_extracted_metadata(raw_metadata)
                    if normalized:
                        # Обновляем таблицу prompt_history_output
                        cursor.execute(
                            "UPDATE prompt_history_output SET metadata = ? WHERE entry_id = ? AND filename = ?",
                            (serialize_metadata(normalized), entry_id, filename)
                        )
                        updated_count += 1
                        LOGGER.debug(f"[PHG] Updated metadata for {filename}: {list(normalized.keys())}")
            
            LOGGER.info(f"[PHG] Automatic metadata import completed: {updated_count} entries updated")
            
        except Exception as e:
            LOGGER.warning(f"[PHG] Automatic metadata import failed: {e}", exc_info=True)

    def _sync_wal_on_startup(self) -> None:
        try:
            wal_file = self._file_path.with_suffix(self._file_path.suffix + "-wal")
            if wal_file.exists() and wal_file.stat().st_size > 0:
                LOGGER.info(f"[PHG] WAL file detected ({wal_file.stat().st_size} bytes), performing checkpoint...")
                with self._lock:
                    cursor = self._connection.cursor()
                    cursor.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    checkpoint_result = cursor.fetchone()
                    LOGGER.info(f"[PHG] Startup WAL checkpoint completed: {checkpoint_result}")
                
                db_size = self._file_path.stat().st_size if self._file_path.exists() else 0
                wal_size_after = wal_file.stat().st_size if wal_file.exists() else 0
                LOGGER.info(f"[PHG] After startup sync - DB: {db_size} bytes, WAL: {wal_size_after} bytes")
            else:
                LOGGER.debug("[PHG] No WAL file or empty WAL file, skipping startup sync")
        except Exception as e:
            LOGGER.warning(f"[PHG] Startup WAL sync failed: {e}", exc_info=True)


_STORAGE_INSTANCE: Optional[PromptHistoryStorage] = None
_INSTANCE_LOCK = threading.Lock()


def get_prompt_history_storage() -> PromptHistoryStorage:
    global _STORAGE_INSTANCE
    if _STORAGE_INSTANCE is None:
        with _INSTANCE_LOCK:
            if _STORAGE_INSTANCE is None:
                _STORAGE_INSTANCE = PromptHistoryStorage()
    return _STORAGE_INSTANCE