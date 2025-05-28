import logging
import os
import sqlite3
import threading
from typing import Generator

from fastapi import HTTPException

from config import DB_BASE_PATH

logger = logging.getLogger(__name__)

initialized_dbs = {}
db_init_lock = threading.Lock()


def create_tables(db_path: str):
    """Creates database tables if they don't exist."""
    conn = None
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        logger.info(f"Checking/Creating tables for database: {db_path}")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_files (
                stableId TEXT PRIMARY KEY, currentEncryptedFilePath TEXT NOT NULL,
                currentMtime INTEGER NOT NULL, currentContentHash TEXT NOT NULL,
                isBinary INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_vault_files_deleted ON vault_files (deleted)")
        logger.debug("Checked/Created vault_files table.")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS file_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, stableId TEXT NOT NULL,
                encryptedFilePath TEXT NOT NULL, encryptedContent TEXT,
                version_time TEXT NOT NULL, mtime INTEGER NOT NULL,
                contentHash TEXT NOT NULL, isBinary INTEGER NOT NULL,
                FOREIGN KEY (stableId) REFERENCES vault_files (stableId) ON DELETE CASCADE )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_file_versions_stableId ON file_versions (stableId)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_file_versions_version_time ON file_versions (version_time)")
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_file_versions_encryptedFilePath ON file_versions (encryptedFilePath)")
        logger.debug("Checked/Created file_versions table.")

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_metadata (
                vault_id TEXT PRIMARY KEY, encryption_validation TEXT )
        """)
        logger.debug("Checked/Created vault_metadata table.")

        conn.commit()
        logger.info(f"Table creation/check complete for: {db_path}")
    except sqlite3.Error as e:
        logger.error(f"Database error during table creation for {db_path}: {e}")
        if conn: conn.rollback()
        raise
    finally:
        if conn: conn.close()


def get_db_dependency_factory():
    def _get_db_connection(vault_id: str) -> Generator[sqlite3.Connection, None, None]:
        db_path = os.path.join(DB_BASE_PATH, f"{vault_id}.db")
        with db_init_lock:
            if vault_id not in initialized_dbs:
                os.makedirs(os.path.dirname(db_path), exist_ok=True)
                try:
                    create_tables(db_path)
                    initialized_dbs[vault_id] = True
                    logger.info(f"Initialized database for vault {vault_id} at {db_path}")
                except Exception as init_err:
                    logger.error(f"Failed to initialize database {db_path}: {init_err}")
                    raise HTTPException(status_code=500, detail="Database initialization failed")

        conn = None
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            yield conn
        except sqlite3.Error as e:
            logger.error(f"Could not connect to database {db_path}: {e}")
            raise HTTPException(status_code=500, detail="Database connection error")
        finally:
            if conn: conn.close()

    return _get_db_connection


get_db = get_db_dependency_factory()
