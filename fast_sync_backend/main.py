import logging
import os

import uvicorn
from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.status import HTTP_422_UNPROCESSABLE_ENTITY

from fast_sync_backend.config import DB_BASE_PATH, API_KEY
from fast_sync_backend.models import HealthResponse
from fast_sync_backend.routers.sync import router as sync_router

logger = logging.getLogger(__name__)

app = FastAPI(title="Fast Sync Server")


class CompressionLoggingMiddleware:
    def __init__(self, app: FastAPI):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            accept_encoding = headers.get(b"accept-encoding", b"").decode()
            content_encoding = headers.get(b"content-encoding", b"").decode()

            original_send = send

            async def wrapped_send(message):
                if message["type"] == "http.response.start":
                    resp_headers = dict(message.get("headers", []))
                    resp_content_encoding = next(
                        (v.decode() for k, v in resp_headers.items() if k.decode().lower() == "content-encoding"), None)

                await original_send(message)

            await self.app(scope, receive, wrapped_send)
        else:
            await self.app(scope, receive, send)


app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(CompressionLoggingMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sync_router)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.error(f"Validation error for request {request.method} {request.url}: {exc.errors()}")
    return JSONResponse(
        status_code=HTTP_422_UNPROCESSABLE_ENTITY,
        content={"detail": "Validation Error", "errors": exc.errors()},
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Unhandled exception for request {request.method} {request.url}")
    if isinstance(exc, HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )

    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"},
    )


@app.get("/v1/health", response_model=HealthResponse, tags=["Health"])
def read_health():
    return {"status": "ok"}


if __name__ == "__main__":
    os.makedirs(DB_BASE_PATH, exist_ok=True)
    logger.info(f"Starting Fast Sync Server...")
    logger.info(f"Using database base path: {os.path.abspath(DB_BASE_PATH)}")
    logger.info(f"API Key Loaded: {'Yes' if API_KEY else 'No'}")

    uvicorn.run("fast_sync_backend.main:app", host="0.0.0.0", port=32400, reload=True)
