import logging
import threading
from typing import Dict, Optional

from fast_sync_backend.models import StateResponseModel

logger = logging.getLogger(__name__)

state_cache: Dict[str, StateResponseModel] = {}
state_cache_lock = threading.Lock()


def invalidate_state_cache(vault_id: str):
    """Removes a vault's state from the in-memory cache."""
    with state_cache_lock:
        if vault_id in state_cache:
            del state_cache[vault_id]
            logger.info(f"Invalidated state cache for vault {vault_id}")


def get_cached_state(vault_id: str) -> Optional[StateResponseModel]:
    """Retrieves state from cache if available."""
    with state_cache_lock:
        return state_cache.get(vault_id)


def set_cached_state(vault_id: str, response: StateResponseModel):
    """Stores state response in the cache."""
    with state_cache_lock:
        state_cache[vault_id] = response
