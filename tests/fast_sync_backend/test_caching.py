import pytest

from fast_sync_backend.caching import (
    invalidate_state_cache,
    get_cached_state,
    set_cached_state,
    state_cache,
    state_cache_lock,
)
from fast_sync_backend.models import StateResponseModel, VaultFileStateModel

VAULT_ID_1 = "vault1"
VAULT_ID_2 = "vault2"
SAMPLE_STATE_DATA = {
    "stable1": VaultFileStateModel(
        currentEncryptedFilePath="enc/path/a.txt",
        currentMtime=1678886400,
        currentContentHash="hash1",
        isBinary=0,
        deleted=False
    )
}
SAMPLE_RESPONSE_1 = StateResponseModel(state=SAMPLE_STATE_DATA, encryptionValidation="marker1")
SAMPLE_RESPONSE_2 = StateResponseModel(state={}, encryptionValidation="marker2")

@pytest.fixture(autouse=True)
def clear_cache():
    """Fixture to ensure the cache is empty before each test."""
    with state_cache_lock:
        state_cache.clear()
    yield 
    with state_cache_lock:
        state_cache.clear() 

def test_set_and_get_cached_state():
    """Test setting and retrieving state from the cache."""
    assert get_cached_state(VAULT_ID_1) is None 

    set_cached_state(VAULT_ID_1, SAMPLE_RESPONSE_1)
    cached = get_cached_state(VAULT_ID_1)

    assert cached is not None
    assert cached == SAMPLE_RESPONSE_1
    assert cached.state == SAMPLE_STATE_DATA
    assert cached.encryptionValidation == "marker1"

    
    assert get_cached_state(VAULT_ID_2) is None

def test_invalidate_state_cache():
    """Test removing state from the cache."""
    set_cached_state(VAULT_ID_1, SAMPLE_RESPONSE_1)
    set_cached_state(VAULT_ID_2, SAMPLE_RESPONSE_2)

    assert get_cached_state(VAULT_ID_1) is not None
    assert get_cached_state(VAULT_ID_2) is not None

    invalidate_state_cache(VAULT_ID_1)

    assert get_cached_state(VAULT_ID_1) is None 
    assert get_cached_state(VAULT_ID_2) is not None 

    
    invalidate_state_cache("non_existent_vault")

def test_get_non_existent_state():
    """Test retrieving state for a vault not in the cache."""
    assert get_cached_state("unknown_vault") is None

def test_cache_update():
    """Test updating the cache for an existing vault."""
    set_cached_state(VAULT_ID_1, SAMPLE_RESPONSE_1)
    assert get_cached_state(VAULT_ID_1) == SAMPLE_RESPONSE_1

    
    updated_data = SAMPLE_STATE_DATA.copy()
    updated_data["stable2"] = VaultFileStateModel(
        currentEncryptedFilePath="enc/path/b.txt",
        currentMtime=1678886401,
        currentContentHash="hash2",
        isBinary=0,
        deleted=False
    )
    updated_response = StateResponseModel(state=updated_data, encryptionValidation="marker1_updated")

    set_cached_state(VAULT_ID_1, updated_response)
    cached = get_cached_state(VAULT_ID_1)

    assert cached is not None
    assert cached == updated_response
    assert len(cached.state) == 2
    assert cached.encryptionValidation == "marker1_updated"



