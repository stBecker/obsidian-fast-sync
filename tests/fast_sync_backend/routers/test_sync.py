import sqlite3
from unittest.mock import MagicMock, patch, ANY

import pytest
from fastapi.testclient import TestClient

from fast_sync_backend import models, dependencies, database
# Import app and models
from fast_sync_backend.main import app  # Use the main app instance

# --- Test Data ---
TEST_VAULT_ID = "test-sync-vault"
TEST_API_KEY = "test-key-sync" # Must match config used by TestClient's app instance
BASE_URL = f"/v1/{TEST_VAULT_ID}"

# Sample file data
FILE_1_DATA = {
    "stableId": "stable_id_1", "filePath": "encrypted/path/file1.md", "content": "encrypted_content_1",
    "mtime": 1678880001, "contentHash": "hash_1", "isBinary": 0, "deleted": False
}
FILE_2_DATA = {
    "stableId": "stable_id_2", "filePath": "encrypted/path/file2.bin", "content": "encrypted_content_2_bin",
    "mtime": 1678880002, "contentHash": "hash_2", "isBinary": 1, "deleted": False
}
FILE_3_DELETED_DATA = {
    "stableId": "stable_id_3", "filePath": "encrypted/path/deleted3.md", "content": "", # Content empty for delete
    "mtime": 1678880003, "contentHash": "hash_3_del", "isBinary": 0, "deleted": True
}

UPLOAD_PAYLOAD_VALID = {
    "data": [FILE_1_DATA, FILE_2_DATA],
    "encryptionValidation": "marker_abc"
}
UPLOAD_PAYLOAD_NO_MARKER = {"data": [FILE_1_DATA]}

FORCE_PUSH_PAYLOAD = {"encryptionValidation": "reset_marker_xyz"}

# --- Mocks ---

# Mock database connection and cursor
@pytest.fixture
def mock_db():
    mock_conn = MagicMock(spec=sqlite3.Connection)
    mock_cursor = MagicMock(spec=sqlite3.Cursor)
    mock_conn.cursor.return_value = mock_cursor
    mock_conn.commit.return_value = None
    mock_conn.rollback.return_value = None
    # Simulate row factory behaviour for fetchone/fetchall if needed
    mock_cursor.fetchone.return_value = None
    mock_cursor.fetchall.return_value = []
    mock_cursor.rowcount = 0 # Default rowcount

    # Use a context manager for the dependency override
    def override_get_db(vault_id: str): # Match signature
         # print(f"Override get_db called for vault: {vault_id}") # Debugging
         yield mock_conn # Yield the connection like the original dependency

    # Apply the override before yielding the client
    app.dependency_overrides[database.get_db] = override_get_db
    yield mock_conn, mock_cursor # Return mocks for configuration in tests
    # Clean up the override after tests
    app.dependency_overrides.pop(database.get_db, None)


# Mock caching functions
@pytest.fixture
def mock_cache():
    with patch('fast_sync_backend.routers.sync.invalidate_state_cache') as mock_invalidate, \
         patch('fast_sync_backend.routers.sync.get_cached_state') as mock_get, \
         patch('fast_sync_backend.routers.sync.set_cached_state') as mock_set:
        # Default: cache miss
        mock_get.return_value = None
        yield mock_invalidate, mock_get, mock_set

# Mock API Key dependency (always succeed)
@pytest.fixture(autouse=True) # Apply automatically to all tests in this module
def mock_api_key():
    async def override_get_api_key():
        return None # Return value isn't used, just need to pass validation
    app.dependency_overrides[dependencies.get_api_key] = override_get_api_key
    yield
    app.dependency_overrides.pop(dependencies.get_api_key, None)

# --- Test Client ---
@pytest.fixture
def client():
    # TestClient uses the app instance with potentially overridden dependencies
    with TestClient(app) as c:
        yield c

# --- Test Cases ---

def test_upload_changes_success(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, _, _ = mock_cache

    # Simulate vault metadata check (no existing marker)
    mock_cursor.fetchone.return_value = None

    response = client.post(f"{BASE_URL}/uploadChanges", json=UPLOAD_PAYLOAD_VALID)

    assert response.status_code == 200
    assert response.json() == {"status": "success"}

    # Verify DB interactions
    # 1. Check for existing marker
    mock_cursor.execute.assert_any_call("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (TEST_VAULT_ID,))
    # 2. Insert/Update marker
    mock_cursor.execute.assert_any_call("INSERT OR REPLACE INTO vault_metadata (vault_id, encryption_validation) VALUES (?, ?)",
                                       (TEST_VAULT_ID, UPLOAD_PAYLOAD_VALID["encryptionValidation"]))
    # 3. Insert/Replace vault_files for each file
    mock_cursor.execute.assert_any_call(ANY, (FILE_1_DATA["stableId"], FILE_1_DATA["filePath"], FILE_1_DATA["mtime"], FILE_1_DATA["contentHash"], FILE_1_DATA["isBinary"], int(FILE_1_DATA["deleted"])))
    mock_cursor.execute.assert_any_call(ANY, (FILE_2_DATA["stableId"], FILE_2_DATA["filePath"], FILE_2_DATA["mtime"], FILE_2_DATA["contentHash"], FILE_2_DATA["isBinary"], int(FILE_2_DATA["deleted"])))
    # 4. Insert file_versions for each file
    mock_cursor.execute.assert_any_call(ANY, (FILE_1_DATA["stableId"], FILE_1_DATA["filePath"], FILE_1_DATA["content"], ANY, FILE_1_DATA["mtime"], FILE_1_DATA["contentHash"], FILE_1_DATA["isBinary"])) # version_time is ANY
    mock_cursor.execute.assert_any_call(ANY, (FILE_2_DATA["stableId"], FILE_2_DATA["filePath"], FILE_2_DATA["content"], ANY, FILE_2_DATA["mtime"], FILE_2_DATA["contentHash"], FILE_2_DATA["isBinary"]))

    # 5. Commit
    mock_conn.commit.assert_called_once()
    mock_conn.rollback.assert_not_called()

    # Verify cache invalidation
    mock_invalidate.assert_called_once_with(TEST_VAULT_ID)


def test_upload_changes_encryption_marker_mismatch_existing(client: TestClient, mock_db):
    _, mock_cursor = mock_db
    # Simulate existing marker in DB that differs from request
    mock_cursor.fetchone.return_value = {"encryption_validation": "existing_marker_xyz"}

    response = client.post(f"{BASE_URL}/uploadChanges", json=UPLOAD_PAYLOAD_VALID) # Payload has "marker_abc"

    assert response.status_code == 409 # Conflict
    assert "Encryption Key Mismatch" in response.json()["detail"]
    mock_cursor.execute.assert_any_call("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (TEST_VAULT_ID,))
    # Should fail before writing data or committing
    assert mock_cursor.execute.call_count == 1 # Only the SELECT query
    mock_db[0].commit.assert_not_called()
    mock_db[0].rollback.assert_not_called() # Rollback not needed if commit wasn't tried


def test_upload_changes_encryption_marker_mismatch_missing(client: TestClient, mock_db):
    _, mock_cursor = mock_db
    # Simulate existing marker in DB
    mock_cursor.fetchone.return_value = {"encryption_validation": "existing_marker_xyz"}

    response = client.post(f"{BASE_URL}/uploadChanges", json=UPLOAD_PAYLOAD_NO_MARKER) # Payload has no marker

    assert response.status_code == 409 # Conflict
    assert "Server expects encrypted data" in response.json()["detail"]
    mock_cursor.execute.assert_any_call("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (TEST_VAULT_ID,))
    assert mock_cursor.execute.call_count == 1
    mock_db[0].commit.assert_not_called()
    mock_db[0].rollback.assert_not_called()


def test_upload_changes_db_error(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, _, _ = mock_cache

    mock_cursor.fetchone.return_value = None # No marker initially
    # Simulate error during INSERT
    mock_cursor.execute.side_effect = [
        None, # SELECT marker -> success (returns None via fetchone default)
        None, # INSERT marker -> success
        sqlite3.Error("DB Insert Failed") # First file insert fails
    ]

    response = client.post(f"{BASE_URL}/uploadChanges", json=UPLOAD_PAYLOAD_VALID)

    assert response.status_code == 500
    assert "Database error during upload" in response.json()["detail"]
    mock_conn.commit.assert_not_called()
    mock_conn.rollback.assert_called_once() # Rollback should be called
    mock_invalidate.assert_not_called() # Should fail before invalidation


def test_download_state_cache_miss_db_success(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, mock_get, mock_set = mock_cache

    # Simulate cache miss handled by mock_get default (returns None)

    # Simulate DB results
    db_files_data = [
        {"stableId": "s1", "currentEncryptedFilePath": "p1", "currentMtime": 1, "currentContentHash": "h1", "isBinary": 0, "deleted": 0},
        {"stableId": "s2", "currentEncryptedFilePath": "p2", "currentMtime": 2, "currentContentHash": "h2", "isBinary": 1, "deleted": 1},
    ]
    db_meta_data = {"encryption_validation": "db_marker"}
    mock_cursor.fetchall.return_value = db_files_data # For vault_files query
    mock_cursor.fetchone.return_value = db_meta_data  # For vault_metadata query

    response = client.get(f"{BASE_URL}/state")

    assert response.status_code == 200
    expected_state = {
        "s1": {"currentEncryptedFilePath": "p1", "currentMtime": 1, "currentContentHash": "h1", "isBinary": 0, "deleted": False},
        "s2": {"currentEncryptedFilePath": "p2", "currentMtime": 2, "currentContentHash": "h2", "isBinary": 1, "deleted": True},
    }
    expected_json = {"state": expected_state, "encryptionValidation": "db_marker"}
    assert response.json() == expected_json

    mock_get.assert_called_once_with(TEST_VAULT_ID)
    # Verify DB calls
    mock_cursor.execute.assert_any_call("SELECT stableId, currentEncryptedFilePath, currentMtime, currentContentHash, isBinary, deleted FROM vault_files")
    mock_cursor.execute.assert_any_call("SELECT encryption_validation FROM vault_metadata WHERE vault_id = ?", (TEST_VAULT_ID,))
    # Verify cache update
    # Need to check the argument passed to set_cached_state matches expected_json structure
    mock_set.assert_called_once()
    call_args = mock_set.call_args[0]
    assert call_args[0] == TEST_VAULT_ID
    assert isinstance(call_args[1], models.StateResponseModel)
    assert call_args[1].model_dump() == expected_json


def test_download_state_db_error(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, mock_get, mock_set = mock_cache
    # Cache miss default

    # Simulate DB error on first query
    mock_cursor.execute.side_effect = sqlite3.Error("DB Select Failed")

    response = client.get(f"{BASE_URL}/state")

    assert response.status_code == 500
    assert "Database error fetching state" in response.json()["detail"]

    mock_get.assert_called_once_with(TEST_VAULT_ID)
    mock_cursor.execute.assert_called_once() # Only the first query attempt
    mock_set.assert_not_called()


def test_download_files_success(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    request_payload = {"encryptedFilePaths": ["enc/path/1", "enc/path/2"]}
    db_data = [
        {"encryptedFilePath": "enc/path/1", "encryptedContent": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0},
        # Simulate duplicate path requested - should only return one
        {"encryptedFilePath": "enc/path/1", "encryptedContent": "c1_dup?", "mtime": 1, "contentHash": "h1_dup?", "isBinary": 0},
        {"encryptedFilePath": "enc/path/2", "encryptedContent": "c2", "mtime": 2, "contentHash": "h2", "isBinary": 1},
        # Simulate a file in DB not requested
        {"encryptedFilePath": "enc/path/other", "encryptedContent": "c_other", "mtime": 3, "contentHash": "h_other", "isBinary": 0},
    ]
    mock_cursor.fetchall.return_value = db_data

    response = client.post(f"{BASE_URL}/downloadFiles", json=request_payload)

    assert response.status_code == 200
    expected_files = [
        {"encryptedFilePath": "enc/path/1", "encryptedContent": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0},
        {"encryptedFilePath": "enc/path/2", "encryptedContent": "c2", "mtime": 2, "contentHash": "h2", "isBinary": 1},
    ]
    assert response.json() == {"files": expected_files}

    # Verify DB query uses placeholders correctly
    expected_sql_fragment = "WHERE encryptedFilePath IN (?, ?)"
    mock_cursor.execute.assert_called_once()
    call_args = mock_cursor.execute.call_args[0]
    assert expected_sql_fragment in call_args[0] # Check the query string
    assert call_args[1] == request_payload["encryptedFilePaths"] # Check the parameters


def test_download_files_empty_request(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    response = client.post(f"{BASE_URL}/downloadFiles", json={"encryptedFilePaths": []})
    assert response.status_code == 200
    assert response.json() == {"files": []}
    mock_cursor.execute.assert_not_called()


def test_download_files_db_error(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    request_payload = {"encryptedFilePaths": ["enc/path/1"]}
    mock_cursor.execute.side_effect = sqlite3.Error("DB Select Files Failed")

    response = client.post(f"{BASE_URL}/downloadFiles", json=request_payload)

    assert response.status_code == 500
    assert "Database error fetching file content" in response.json()["detail"]


def test_get_file_history_success(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    stable_id = "history_stable_id"
    db_data = [
        {"encryptedFilePath": "p1_v2", "encryptedContent": "c1_v2", "mtime": 2, "contentHash": "h1_v2", "isBinary": 0, "version_time": "2023-02-01T00:00:00Z"},
        {"encryptedFilePath": "p1_v1", "encryptedContent": "c1_v1", "mtime": 1, "contentHash": "h1_v1", "isBinary": 0, "version_time": "2023-01-01T00:00:00Z"},
    ]
    mock_cursor.fetchall.return_value = db_data

    response = client.get(f"{BASE_URL}/fileHistory/{stable_id}")

    assert response.status_code == 200
    expected_json = [
        {"filePath": "p1_v2", "content": "c1_v2", "mtime": 2, "contentHash": "h1_v2", "isBinary": 0, "version_time": "2023-02-01T00:00:00Z"},
        {"filePath": "p1_v1", "content": "c1_v1", "mtime": 1, "contentHash": "h1_v1", "isBinary": 0, "version_time": "2023-01-01T00:00:00Z"},
    ]
    assert response.json() == expected_json

    mock_cursor.execute.assert_called_once_with(ANY, (stable_id,))
    assert "ORDER BY version_time DESC" in mock_cursor.execute.call_args[0][0]


def test_get_file_history_not_found(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    stable_id = "non_existent_stable_id"
    mock_cursor.fetchall.return_value = [] # Simulate no results

    response = client.get(f"{BASE_URL}/fileHistory/{stable_id}")

    assert response.status_code == 200
    assert response.json() == []
    mock_cursor.execute.assert_called_once_with(ANY, (stable_id,))


def test_get_file_history_db_error(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    stable_id = "error_stable_id"
    mock_cursor.execute.side_effect = sqlite3.Error("DB History Failed")

    response = client.get(f"{BASE_URL}/fileHistory/{stable_id}")

    assert response.status_code == 500
    assert "Database error fetching file history" in response.json()["detail"]


def test_get_all_files_success(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    db_data = [
        {"stableId": "s1", "currentEncryptedFilePath": "p1"},
        {"stableId": "s2", "currentEncryptedFilePath": "p2"},
    ]
    mock_cursor.fetchall.return_value = db_data

    response = client.get(f"{BASE_URL}/allFiles")

    assert response.status_code == 200
    expected_json = [
        {"stableId": "s1", "currentEncryptedFilePath": "p1"},
        {"stableId": "s2", "currentEncryptedFilePath": "p2"},
    ]
    assert response.json() == expected_json
    mock_cursor.execute.assert_called_once_with(ANY) # Check if the correct query is called
    assert "FROM vault_files v" in mock_cursor.execute.call_args[0][0]


def test_get_all_files_db_error(client: TestClient, mock_db):
    mock_conn, mock_cursor = mock_db
    mock_cursor.execute.side_effect = sqlite3.Error("DB All Files Failed")

    response = client.get(f"{BASE_URL}/allFiles")

    assert response.status_code == 500
    assert "Database error fetching all file IDs" in response.json()["detail"]


def test_force_push_reset_success(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, _, _ = mock_cache

    # Simulate row counts for deletes
    mock_cursor.rowcount = 5 # For file_versions delete
    def rowcount_side_effect(*args, **kwargs):
        if "DELETE FROM file_versions" in args[0]:
            mock_cursor.rowcount = 5
        elif "DELETE FROM vault_files" in args[0]:
            mock_cursor.rowcount = 2
        else:
            mock_cursor.rowcount = 0 # For INSERT marker
        return None # execute returns None
    mock_cursor.execute.side_effect = rowcount_side_effect

    response = client.post(f"{BASE_URL}/forcePushReset", json=FORCE_PUSH_PAYLOAD)

    assert response.status_code == 200
    assert response.json() == {"status": "reset_success"}

    # Verify DB calls
    mock_cursor.execute.assert_any_call("DELETE FROM file_versions")
    mock_cursor.execute.assert_any_call("DELETE FROM vault_files")
    mock_cursor.execute.assert_any_call("INSERT OR REPLACE INTO vault_metadata (vault_id, encryption_validation) VALUES (?, ?)",
                                       (TEST_VAULT_ID, FORCE_PUSH_PAYLOAD["encryptionValidation"]))
    mock_conn.commit.assert_called_once()
    mock_conn.rollback.assert_not_called()

    # Verify cache invalidation
    mock_invalidate.assert_called_once_with(TEST_VAULT_ID)


def test_force_push_reset_db_error(client: TestClient, mock_db, mock_cache):
    mock_conn, mock_cursor = mock_db
    mock_invalidate, _, _ = mock_cache

    # Simulate error during DELETE
    mock_cursor.execute.side_effect = sqlite3.Error("DB Reset Delete Failed")

    response = client.post(f"{BASE_URL}/forcePushReset", json=FORCE_PUSH_PAYLOAD)

    assert response.status_code == 500
    assert "Database error during vault reset" in response.json()["detail"]
    mock_conn.commit.assert_not_called()
    mock_conn.rollback.assert_called_once()
    mock_invalidate.assert_not_called()