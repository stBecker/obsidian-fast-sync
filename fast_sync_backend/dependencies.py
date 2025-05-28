from fastapi import Header, HTTPException
from starlette.status import HTTP_401_UNAUTHORIZED

from config import API_KEY


async def get_api_key(x_api_key: str = Header(...)):
    """Dependency to check the API Key header."""
    if x_api_key != API_KEY:
        raise HTTPException(status_code=HTTP_401_UNAUTHORIZED, detail="Invalid API Key")
