import importlib
import os
from unittest.mock import patch

from fast_sync_backend import config


def test_config_defaults():
    """Test default config values when environment variables are not set."""
    
    with patch.dict(os.environ, {}, clear=True):
        
        importlib.reload(config)
        assert config.API_KEY == "hunter2"
        assert config.DB_BASE_PATH == "data"

def test_config_from_env():
    """Test config values loaded from environment variables."""
    test_api_key = "test_key_123"
    test_db_path = "/test/db/path"
    env_vars = {
        "API_KEY": test_api_key,
        "DB_BASE_PATH": test_db_path,
    }
    with patch.dict(os.environ, env_vars, clear=True):
        
        importlib.reload(config)
        assert config.API_KEY == test_api_key
        assert config.DB_BASE_PATH == test_db_path


def teardown_module(module):
    importlib.reload(config) 