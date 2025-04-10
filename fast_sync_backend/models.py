from typing import List, Optional, Dict

from pydantic import BaseModel


class VersionDataPayload(BaseModel):
    """Data for a single file version being uploaded."""
    stableId: str
    filePath: str
    content: str
    mtime: int
    contentHash: str
    isBinary: int
    deleted: bool


class UploadChangesPayload(BaseModel):
    """Payload for the uploadChanges endpoint."""
    data: List[VersionDataPayload]
    encryptionValidation: Optional[str] = None


class VaultFileStateModel(BaseModel):
    """Represents the logical file state returned by /state."""
    currentEncryptedFilePath: str
    currentMtime: int
    currentContentHash: str
    isBinary: int
    deleted: bool


class StateResponseModel(BaseModel):
    """Response for the /state endpoint."""
    state: Dict[str, VaultFileStateModel]
    encryptionValidation: Optional[str] = None


class DownloadFilesRequestModel(BaseModel):
    """Request payload for /downloadFiles."""
    encryptedFilePaths: List[str]


class DownloadedFileContentModel(BaseModel):
    """Data returned for each requested file in /downloadFiles."""
    encryptedFilePath: str
    encryptedContent: str
    mtime: int
    contentHash: str
    isBinary: int


class DownloadFilesResponseModel(BaseModel):
    """Response for the /downloadFiles endpoint."""
    files: List[DownloadedFileContentModel]


class HistoryEntryModel(BaseModel):
    """Data returned for each entry in /fileHistory."""
    filePath: str
    content: str
    mtime: int
    contentHash: str
    isBinary: int
    version_time: str


class FileListEntryModel(BaseModel):
    """Data structure for the file list returned by /allFiles."""
    stableId: str
    currentEncryptedFilePath: str


class HealthResponse(BaseModel):
    status: str


class UploadChangesResponse(BaseModel):
    status: str


class ForcePushResetPayload(BaseModel):
    encryptionValidation: Optional[str] = None


class ForcePushResetResponse(BaseModel):
    status: str
