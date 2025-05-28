import datetime
import logging
import sqlite3
import time
from typing import List, Dict, Annotated

from fastapi import APIRouter, Depends, HTTPException, Body, Path
from starlette.status import HTTP_409_CONFLICT

import models
from caching import invalidate_state_cache, get_cached_state, set_cached_state
from database import get_db
from dependencies import get_api_key

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/v1/{vault_id}/uploadChanges", response_model=models.UploadChangesResponse)
def upload_changes(
        vault_id: str,
        payload: Annotated[models.UploadChangesPayload, Body(...)],
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key),
):
    start_time = time.time()
    files_data = payload.data
    request_encryption_marker = payload.encryptionValidation
    logger.info(
        f"Received uploadChanges for vault {vault_id}: {len(files_data)} files. Marker: {bool(request_encryption_marker)}")

    cursor = db.cursor()
    try:

        cursor.execute("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (vault_id,))
        meta_row = cursor.fetchone()
        existing_encryption_marker = meta_row['encryption_validation'] if meta_row else None

        if existing_encryption_marker and request_encryption_marker:
            if existing_encryption_marker != request_encryption_marker:
                logger.error(f"Encryption marker mismatch for vault {vault_id}.")
                raise HTTPException(status_code=HTTP_409_CONFLICT, detail="Encryption Key Mismatch")
        elif existing_encryption_marker and not request_encryption_marker:
            logger.error(f"Encryption marker missing in request for vault {vault_id}, fast_sync_backend expects encrypted.")
            raise HTTPException(status_code=HTTP_409_CONFLICT,
                                detail="Encryption Mismatch: Server expects encrypted data.")

        if request_encryption_marker:
            cursor.execute("INSERT OR REPLACE INTO vault_metadata (vault_id, encryption_validation) VALUES (?, ?)",
                           (vault_id, request_encryption_marker))

        current_time_iso = datetime.datetime.utcnow().isoformat()
        for file in files_data:
            cursor.execute("""
                INSERT OR REPLACE INTO vault_files
                    (stableId, currentEncryptedFilePath, currentMtime, currentContentHash, isBinary, deleted)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (file.stableId, file.filePath, file.mtime, file.contentHash, file.isBinary, int(file.deleted)))

            cursor.execute("""
                INSERT INTO file_versions
                    (stableId, encryptedFilePath, encryptedContent, version_time, mtime, contentHash, isBinary)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
            file.stableId, file.filePath, file.content, current_time_iso, file.mtime, file.contentHash, file.isBinary))

        db.commit()
        invalidate_state_cache(vault_id)
        response = {"status": "success"}
    except sqlite3.Error as e:
        db.rollback()
        logger.error(f"Database error during uploadChanges for vault {vault_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Database error during upload: {e}")
    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        db.rollback()
        logger.error(f"Unexpected error during uploadChanges for vault {vault_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Unexpected fast_sync_backend error.")

    end_time = time.time()
    logger.info(f"uploadChanges completed for vault {vault_id}, latency: {end_time - start_time:.2f}s")
    return response


@router.get("/v1/{vault_id}/state", response_model=models.StateResponseModel)
def download_state(
        vault_id: str,
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key),
):
    start_time = time.time()
    logger.info(f"Received downloadState request for vault {vault_id}")

    cached_response = get_cached_state(vault_id)
    if cached_response:
        end_time = time.time()
        logger.info(f"downloadState response for vault {vault_id} (from cache), latency: {end_time - start_time:.2f}s")
        return cached_response

    try:
        cursor = db.cursor()
        cursor.execute(
            "SELECT stableId, currentEncryptedFilePath, currentMtime, currentContentHash, isBinary, deleted FROM vault_files")
        rows = cursor.fetchall()
        state_dict = {
            row['stableId']: models.VaultFileStateModel(
                currentEncryptedFilePath=row['currentEncryptedFilePath'],
                currentMtime=row['currentMtime'],
                currentContentHash=row['currentContentHash'],
                isBinary=row['isBinary'],
                deleted=bool(row['deleted'])
            ) for row in rows
        }

        cursor.execute("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (vault_id,))
        meta_row = cursor.fetchone()
        encryption_validation_marker = meta_row['encryption_validation'] if meta_row else None

        response = models.StateResponseModel(
            state=state_dict,
            encryptionValidation=encryption_validation_marker
        )

        set_cached_state(vault_id, response)

        end_time = time.time()
        logger.info(f"downloadState response for vault {vault_id} (from db), latency: {end_time - start_time:.2f}s")
        return response

    except sqlite3.Error as e:
        logger.error(f"Database error during downloadState for vault {vault_id}: {e}")
        raise HTTPException(status_code=500, detail="Database error fetching state")
    except Exception as e:
        logger.error(f"Unexpected error during downloadState for vault {vault_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Unexpected fast_sync_backend error")


@router.post("/v1/{vault_id}/downloadFiles", response_model=models.DownloadFilesResponseModel)
def download_files(
        vault_id: str,
        data: models.DownloadFilesRequestModel,
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key),
):
    start_time = time.time()
    requested_encrypted_paths = data.encryptedFilePaths
    logger.info(f"Received downloadFiles request for vault {vault_id}: {len(requested_encrypted_paths)} paths")

    if not requested_encrypted_paths:
        return models.DownloadFilesResponseModel(files=[])

    try:
        cursor = db.cursor()
        placeholders = ', '.join('?' for _ in requested_encrypted_paths)
        query = f"""
            SELECT encryptedFilePath, encryptedContent, mtime, contentHash, isBinary
            FROM file_versions
            WHERE encryptedFilePath IN ({placeholders})
        """
        cursor.execute(query, requested_encrypted_paths)
        rows = cursor.fetchall()

        found_files_dict: Dict[str, models.DownloadedFileContentModel] = {}
        for row in rows:
            path = row['encryptedFilePath']
            if path in requested_encrypted_paths and path not in found_files_dict:
                found_files_dict[path] = models.DownloadedFileContentModel(
                    encryptedFilePath=row['encryptedFilePath'],
                    encryptedContent=row['encryptedContent'],
                    mtime=row['mtime'],
                    contentHash=row['contentHash'],
                    isBinary=row['isBinary'],
                )

        response_files = list(found_files_dict.values())
        response = models.DownloadFilesResponseModel(files=response_files)

    except sqlite3.Error as e:
        logger.error(f"Database error during downloadFiles for vault {vault_id}: {e}")
        raise HTTPException(status_code=500, detail="Database error fetching file content")
    except Exception as e:
        logger.error(f"Unexpected error during downloadFiles for vault {vault_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Unexpected fast_sync_backend error")

    end_time = time.time()

    logger.info(
        f"downloadFiles response for vault {vault_id}: Found {len(response.files)} files, latency: {end_time - start_time:.2f}s")
    return response


@router.get("/v1/{vault_id}/fileHistory/{stable_id}", response_model=List[models.HistoryEntryModel])
def get_file_history(
        vault_id: str,
        stable_id: str = Path(..., title="Stable ID (SHA-256 hash) of the file"),
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key),
):
    start_time = time.time()

    try:
        cursor = db.cursor()
        cursor.execute("""
            SELECT encryptedFilePath, encryptedContent, mtime, contentHash, isBinary, version_time
            FROM file_versions
            WHERE stableId = ?
            ORDER BY version_time DESC
        """, (stable_id,))
        rows = cursor.fetchall()

        response = [
            models.HistoryEntryModel(
                filePath=row['encryptedFilePath'],
                content=row['encryptedContent'],
                mtime=row['mtime'],
                contentHash=row['contentHash'],
                isBinary=row['isBinary'],
                version_time=row['version_time'],
            )
            for row in rows
        ]
    except sqlite3.Error as e:
        logger.error(f"Database error during fileHistory for vault {vault_id}, stableId {stable_id[:10]}: {e}")
        raise HTTPException(status_code=500, detail="Database error fetching file history")
    except Exception as e:
        logger.error(f"Unexpected error during fileHistory for vault {vault_id}, stableId {stable_id[:10]}: {e}",
                     exc_info=True)
        raise HTTPException(status_code=500, detail="Unexpected fast_sync_backend error")

    end_time = time.time()
    logger.info(
        f"fileHistory response for vault {vault_id}, stableId {stable_id[:10]}: {len(response)} versions, latency: {end_time - start_time:.2f}s")
    return response


@router.get("/v1/{vault_id}/allFiles", response_model=List[models.FileListEntryModel])
def get_all_files(
        vault_id: str,
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key)
):
    start_time = time.time()
    logger.info(f"Received allFiles request for vault {vault_id}")

    try:
        cursor = db.cursor()

        cursor.execute("""
           SELECT
               v.stableId,
               v.currentEncryptedFilePath
           FROM vault_files v
           ORDER BY v.stableId; -- Or however client wants it sorted
       """)

        rows = cursor.fetchall()
        file_list = [
            models.FileListEntryModel(
                stableId=row['stableId'],
                currentEncryptedFilePath=row['currentEncryptedFilePath']
            )
            for row in rows
        ]
    except sqlite3.Error as e:
        logger.error(f"Database error during allFiles for vault {vault_id}: {e}")
        raise HTTPException(status_code=500, detail="Database error fetching all file IDs")
    except Exception as e:
        logger.error(f"Unexpected error during allFiles for vault {vault_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Unexpected fast_sync_backend error")

    end_time = time.time()
    logger.info(
        f"allFiles response for vault {vault_id}: {len(file_list)} files, latency: {end_time - start_time:.2f}s")
    return file_list


@router.post("/v1/{vault_id}/forcePushReset", response_model=models.ForcePushResetResponse)
def force_push_reset(
        vault_id: str,
        payload: Annotated[models.ForcePushResetPayload, Body(...)],
        db: sqlite3.Connection = Depends(get_db),
        api_key: None = Depends(get_api_key),
):
    start_time = time.time()
    encryption_validation = payload.encryptionValidation
    logger.warning(f"Received forcePushReset for vault {vault_id}. Marker: {bool(encryption_validation)}")

    cursor = db.cursor()
    try:

        logger.info(f"Deleting file versions for vault {vault_id}...")
        cursor.execute("DELETE FROM file_versions")
        deleted_versions_count = cursor.rowcount
        logger.info(f"Deleted {deleted_versions_count} version entries.")

        logger.info(f"Deleting logical file states for vault {vault_id}...")
        cursor.execute("DELETE FROM vault_files")
        deleted_files_count = cursor.rowcount
        logger.info(f"Deleted {deleted_files_count} logical file entries.")

        logger.info(f"Resetting encryption validation marker for vault {vault_id}...")
        cursor.execute("INSERT OR REPLACE INTO vault_metadata (vault_id, encryption_validation) VALUES (?, ?)",
                       (vault_id, encryption_validation))

        db.commit()
        invalidate_state_cache(vault_id)
        response = {"status": "reset_success"}

    except sqlite3.Error as e:
        db.rollback()
        logger.error(f"Database error during forcePushReset for vault {vault_id}: {e}")
        raise HTTPException(status_code=500, detail="Database error during vault reset")
    except Exception as e:
        db.rollback()
        logger.error(f"Unexpected error during forcePushReset for vault {vault_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Unexpected fast_sync_backend error")

    end_time = time.time()
    logger.warning(f"forcePushReset complete for vault {vault_id}, latency: {end_time - start_time:.2f}s")
    return response
