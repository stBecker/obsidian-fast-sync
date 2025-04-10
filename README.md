# Fast Sync: Real-time File Synchronization for Obsidian Vaults

Fast Sync is a powerful plugin for Obsidian that enables seamless synchronization of your vaults across multiple devices with robust features like end-to-end encryption and version history.

## Features

### Core Functionality
- **Real-time Synchronization**: Automatically syncs your vault files across devices
- **End-to-End Encryption**: Optional encryption for secure file storage
- **Version History**: Track changes and restore previous file versions
- **Force Push/Pull**: Complete control over synchronization direction
- **Plugin Sync**: Optional synchronization of installed plugin files

### Security
- **Encryption Validation**: Robust protection against key mismatches
- **API Key Authentication**: Secure access to your sync server
- **No Third-Party Services**: Self-hosted solution for maximum privacy

### User Experience
- **Status Bar Indicator**: Shows sync status and last sync time
- **File History Browser**: View and restore previous versions of any file
- **Log Viewer**: Detailed logging for troubleshooting
- **Empty Folder Cleanup**: Automatically removes empty folders

## Backend Setup Instructions

### Using Docker (Recommended)

The easiest way to set up the Fast Sync backend is using Docker Compose:

1. Clone or download the repository
2. Create a `.env` file in the repository root with the following variables (optional):
   ```
   API_KEY=your_secure_api_key
   DB_BASE_PATH=/data
   ```
3. Start the backend server:
   ```bash
   docker-compose up -d
   ```

The server will be available at `http://localhost:32400`.

### Manual Setup

If you prefer to run the backend without Docker:

1. Ensure Python 3.12+ is installed
2. Clone or download the repository
3. Install dependencies:
   ```bash
   pip install uv
   uv sync
   ```
4. Configure environment variables:
   ```bash
   export API_KEY=your_secure_api_key
   export DB_BASE_PATH=./data
   ```
5. Create the data directory:
   ```bash
   mkdir -p ./data
   ```
6. Start the backend server:
   ```bash
   uvicorn fast_sync_backend.main:app --host 0.0.0.0 --port 32400
   ```

### Backend Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `API_KEY` | Authentication key for securing your backend | `hunter2` |
| `DB_BASE_PATH` | Path where vault data will be stored | `data` |

## Database Structure

Fast Sync uses SQLite databases for storing vault data:

- **vault_files**: Stores the logical state of files (current paths, hashes)
- **file_versions**: Stores version history for each file
- **vault_metadata**: Stores vault-level metadata like encryption validation

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/{vault_id}/uploadChanges` | POST | Upload local file changes to the server |
| `/v1/{vault_id}/state` | GET | Get the current logical state of all files |
| `/v1/{vault_id}/downloadFiles` | POST | Download file content from the server |
| `/v1/{vault_id}/fileHistory/{stable_id}` | GET | Get version history of a specific file |
| `/v1/{vault_id}/allFiles` | GET | List all files in the vault |
| `/v1/{vault_id}/forcePushReset` | POST | Reset server state for force push |
| `/v1/health` | GET | Check if the server is running |

## Plugin Configuration

After setting up the backend, configure the plugin in Obsidian:

1. Install the Fast Sync plugin in Obsidian
2. Open plugin settings and enter:
   - **Server URL**: URL of your backend (e.g., `http://localhost:32400`)
   - **API Key**: Same key configured in your backend
   - **Vault ID**: Identifier for this vault (defaults to vault name)

### Encryption Setup

To enable end-to-end encryption:

1. Enter a strong encryption password in the plugin settings
2. Perform a "Force Push" to encrypt all data on the server

**Important**: Remember your encryption password! If lost, you cannot recover your encrypted data.
