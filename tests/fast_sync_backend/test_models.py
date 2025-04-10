import pytest
from pydantic import ValidationError

# Import all models from models.py
from fast_sync_backend import models


def test_version_data_payload_valid():
    data = {
        "stableId": "s1", "filePath": "fp1", "content": "c1", "mtime": 1,
        "contentHash": "h1", "isBinary": 0, "deleted": False
    }
    try:
        models.VersionDataPayload(**data)
    except ValidationError as e:
        pytest.fail(f"Valid VersionDataPayload failed validation: {e}")

def test_version_data_payload_invalid():
    # Missing required field 'stableId'
    data = {
        "filePath": "fp1", "content": "c1", "mtime": 1,
        "contentHash": "h1", "isBinary": 0, "deleted": False
    }
    with pytest.raises(ValidationError):
        models.VersionDataPayload(**data)
    # Incorrect type for 'mtime'
    data = {
        "stableId": "s1", "filePath": "fp1", "content": "c1", "mtime": "not-an-int",
        "contentHash": "h1", "isBinary": 0, "deleted": False
    }
    with pytest.raises(ValidationError):
         models.VersionDataPayload(**data)

def test_upload_changes_payload_valid():
    data = {
        "data": [
            {"stableId": "s1", "filePath": "fp1", "content": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0, "deleted": False},
            {"stableId": "s2", "filePath": "fp2", "content": "c2", "mtime": 2, "contentHash": "h2", "isBinary": 1, "deleted": True},
        ],
        "encryptionValidation": "optional_marker"
    }
    try:
        models.UploadChangesPayload(**data)
    except ValidationError as e:
        pytest.fail(f"Valid UploadChangesPayload failed validation: {e}")

    # Test without optional field
    data_no_marker = { "data": [] }
    try:
        models.UploadChangesPayload(**data_no_marker)
    except ValidationError as e:
         pytest.fail(f"Valid UploadChangesPayload (no marker) failed validation: {e}")

def test_upload_changes_payload_invalid():
    # data is not a list
    data = {"data": {"stableId": "s1"}, "encryptionValidation": "m"}
    with pytest.raises(ValidationError):
        models.UploadChangesPayload(**data)
    # item in data list is invalid
    data = {
        "data": [
            {"stableId": "s1", "filePath": "fp1", "content": "c1", "mtime": "bad_type", "contentHash": "h1", "isBinary": 0, "deleted": False}
        ]
    }
    with pytest.raises(ValidationError):
         models.UploadChangesPayload(**data)

def test_vault_file_state_model_valid():
    data = {"currentEncryptedFilePath": "p1", "currentMtime": 1, "currentContentHash": "h1", "isBinary": 0, "deleted": False}
    try:
        models.VaultFileStateModel(**data)
    except ValidationError as e:
        pytest.fail(f"Valid VaultFileStateModel failed validation: {e}")

def test_state_response_model_valid():
    data = {
        "state": {
            "stable1": {"currentEncryptedFilePath": "p1", "currentMtime": 1, "currentContentHash": "h1", "isBinary": 0, "deleted": False},
            "stable2": {"currentEncryptedFilePath": "p2", "currentMtime": 2, "currentContentHash": "h2", "isBinary": 1, "deleted": True},
        },
        "encryptionValidation": "marker"
    }
    try:
        models.StateResponseModel(**data)
    except ValidationError as e:
         pytest.fail(f"Valid StateResponseModel failed validation: {e}")

    # Test optional encryptionValidation
    data_no_marker = {"state": {}}
    try:
        models.StateResponseModel(**data_no_marker)
    except ValidationError as e:
        pytest.fail(f"Valid StateResponseModel (no marker) failed validation: {e}")


def test_download_files_request_model_valid():
    data = {"encryptedFilePaths": ["enc/path/1", "enc/path/2"]}
    try:
        models.DownloadFilesRequestModel(**data)
    except ValidationError as e:
        pytest.fail(f"Valid DownloadFilesRequestModel failed validation: {e}")

def test_downloaded_file_content_model_valid():
     data = {"encryptedFilePath": "p1", "encryptedContent": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0}
     try:
         models.DownloadedFileContentModel(**data)
     except ValidationError as e:
         pytest.fail(f"Valid DownloadedFileContentModel failed validation: {e}")

def test_download_files_response_model_valid():
     data = {
         "files": [
             {"encryptedFilePath": "p1", "encryptedContent": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0},
             {"encryptedFilePath": "p2", "encryptedContent": "c2", "mtime": 2, "contentHash": "h2", "isBinary": 1},
         ]
     }
     try:
         models.DownloadFilesResponseModel(**data)
     except ValidationError as e:
         pytest.fail(f"Valid DownloadFilesResponseModel failed validation: {e}")

def test_history_entry_model_valid():
     data = {"filePath": "p1", "content": "c1", "mtime": 1, "contentHash": "h1", "isBinary": 0, "version_time": "2023-01-01T00:00:00Z"}
     try:
         models.HistoryEntryModel(**data)
     except ValidationError as e:
         pytest.fail(f"Valid HistoryEntryModel failed validation: {e}")

def test_file_list_entry_model_valid():
     data = {"stableId": "s1", "currentEncryptedFilePath": "p1"}
     try:
         models.FileListEntryModel(**data)
     except ValidationError as e:
         pytest.fail(f"Valid FileListEntryModel failed validation: {e}")

def test_health_response_valid():
     data = {"status": "ok"}
     try:
         models.HealthResponse(**data)
     except ValidationError as e:
         pytest.fail(f"Valid HealthResponse failed validation: {e}")

def test_upload_changes_response_valid():
    data = {"status": "success"}
    try:
        models.UploadChangesResponse(**data)
    except ValidationError as e:
        pytest.fail(f"Valid UploadChangesResponse failed validation: {e}")

def test_force_push_reset_payload_valid():
     data = {"encryptionValidation": "marker"}
     try:
         models.ForcePushResetPayload(**data)
     except ValidationError as e:
         pytest.fail(f"Valid ForcePushResetPayload failed validation: {e}")
     # Test optional
     data_no_marker = {}
     try:
          models.ForcePushResetPayload(**data_no_marker)
     except ValidationError as e:
          pytest.fail(f"Valid ForcePushResetPayload (no marker) failed validation: {e}")

def test_force_push_reset_response_valid():
    data = {"status": "reset_success"}
    try:
        models.ForcePushResetResponse(**data)
    except ValidationError as e:
        pytest.fail(f"Valid ForcePushResetResponse failed validation: {e}")