import pytest
from fastapi import HTTPException

from fast_sync_backend.config import API_KEY
from fast_sync_backend.dependencies import get_api_key


@pytest.mark.asyncio
async def test_get_api_key_success():
    try:
        result = await get_api_key(x_api_key=API_KEY)
        assert result is None
    except HTTPException:
        pytest.fail("HTTPException raised unexpectedly for correct API key.")

@pytest.mark.asyncio
async def test_get_api_key_invalid():
    incorrect_key = "wrong-key"
    with pytest.raises(HTTPException) as exc_info:
        await get_api_key(x_api_key=incorrect_key)

    assert exc_info.value.status_code == 401
    assert "Invalid API Key" in exc_info.value.detail

@pytest.mark.asyncio
async def test_get_api_key_empty_config():
    with pytest.raises(HTTPException) as exc_info:
        await get_api_key(x_api_key="some-key")
        assert exc_info.value.status_code == 401

    
    with pytest.raises(HTTPException) as exc_info_empty:
        await get_api_key(x_api_key="")
    assert exc_info_empty.value.status_code == 401