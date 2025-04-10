import os
import sqlite3
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException

from fast_sync_backend.config import DB_BASE_PATH
from fast_sync_backend.database import create_tables, get_db_dependency_factory, initialized_dbs, db_init_lock

TEST_DB_PATH = os.path.join(DB_BASE_PATH, "test_vault.db")
TEST_VAULT_ID = "test_vault"

@pytest.fixture(autouse=True)
def reset_initialized_dbs():
    """Clear the initialized DB tracker before each test."""
    with db_init_lock:
        initialized_dbs.clear()
    yield
    with db_init_lock:
        initialized_dbs.clear()

@patch('sqlite3.connect')
def test_create_tables_success(mock_connect):
    """Test that create_tables executes correct SQL statements."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_connect.return_value = mock_conn
    mock_conn.cursor.return_value = mock_cursor

    create_tables(TEST_DB_PATH)

    mock_connect.assert_called_once_with(TEST_DB_PATH)
    mock_conn.cursor.assert_called_once()

    
    execute_calls = mock_cursor.execute.call_args_list
    sql_statements = [c.args[0] for c in execute_calls]

    assert any("CREATE TABLE IF NOT EXISTS vault_files" in s for s in sql_statements)
    assert any("CREATE INDEX IF NOT EXISTS idx_vault_files_deleted" in s for s in sql_statements)
    assert any("CREATE TABLE IF NOT EXISTS file_versions" in s for s in sql_statements)
    assert any("CREATE INDEX IF NOT EXISTS idx_file_versions_stableId" in s for s in sql_statements)
    assert any("CREATE INDEX IF NOT EXISTS idx_file_versions_version_time" in s for s in sql_statements)
    assert any("CREATE INDEX IF NOT EXISTS idx_file_versions_encryptedFilePath" in s for s in sql_statements)
    assert any("FOREIGN KEY (stableId) REFERENCES vault_files (stableId) ON DELETE CASCADE" in s for s in sql_statements)
    assert any("CREATE TABLE IF NOT EXISTS vault_metadata" in s for s in sql_statements)

    mock_conn.commit.assert_called_once()
    mock_conn.close.assert_called_once()
    mock_conn.rollback.assert_not_called()


@patch('sqlite3.connect')
def test_create_tables_db_error(mock_connect):
    """Test create_tables error handling during execution."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_connect.return_value = mock_conn
    mock_conn.cursor.return_value = mock_cursor
    mock_cursor.execute.side_effect = sqlite3.Error("Test DB Error")

    with pytest.raises(sqlite3.Error, match="Test DB Error"):
        create_tables(TEST_DB_PATH)

    mock_conn.commit.assert_not_called()
    mock_conn.rollback.assert_called_once() 
    mock_conn.close.assert_called_once()


@patch('fast_sync_backend.database.create_tables', side_effect=Exception("Init Failed"))
@patch('sqlite3.connect')
@patch('os.makedirs')
def test_get_db_dependency_factory_init_error(mock_makedirs, mock_connect, mock_create_tables):
    """Test error handling during the initial create_tables call."""
    get_db_func = get_db_dependency_factory()

    with pytest.raises(HTTPException) as exc_info:
        
        next(get_db_func(TEST_VAULT_ID))

    assert exc_info.value.status_code == 500
    assert "Database initialization failed" in exc_info.value.detail
    mock_connect.assert_not_called() 


@patch('fast_sync_backend.database.create_tables')
@patch('sqlite3.connect', side_effect=sqlite3.Error("Connection Failed"))
@patch('os.makedirs')
def test_get_db_dependency_factory_connect_error(mock_makedirs, mock_connect, mock_create_tables):
    """Test error handling if sqlite3.connect fails."""
    get_db_func = get_db_dependency_factory()

    with pytest.raises(HTTPException) as exc_info:
        
        next(get_db_func(TEST_VAULT_ID))

    assert exc_info.value.status_code == 500
    assert "Database connection error" in exc_info.value.detail
    
    mock_create_tables.assert_called_once()