from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from fast_sync_backend.main import app


@pytest.fixture(scope="module")
def client():
    """Create a TestClient instance for the app."""
    
    
    
    with TestClient(app) as c:
        yield c
    
    


def test_health_check(client: TestClient):
    """Test the /v1/health endpoint."""
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_middleware(client: TestClient):
    """Test that CORS headers allow all origins."""
    
    
    response = client.get("/v1/health", headers={"Origin": "http://example.com"})
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "*"
    
    

def test_validation_exception_handler(client: TestClient):
    """Test the RequestValidationError handler."""
    
    class ValidationModel(BaseModel):
        name: str
        age: int

    @app.post("/test/validation")
    async def validation_endpoint(item: ValidationModel):
        return {"status": "ok"}

    
    invalid_payload = {"name": 123}
    response = client.post("/test/validation", json=invalid_payload)

    assert response.status_code == 422 
    json_response = response.json()
    assert "detail" in json_response
    assert "Validation Error" == json_response["detail"]

    
    valid_payload = {"name": "test", "age": 30}
    response_ok = client.post("/test/validation", json=valid_payload)
    assert response_ok.status_code == 200
    assert response_ok.json() == {"status": "ok"}


def test_http_exception_passthrough(client: TestClient):
    """Test that HTTPErrors are handled correctly (not caught by generic)."""
    error_message = "Specific HTTP Error"
    status_code = 418 

    @app.get("/test/http_error")
    async def http_error_endpoint():
        raise HTTPException(status_code=status_code, detail=error_message)

    
    with patch('fast_sync_backend.main.logger.exception') as mock_log:
         response = client.get("/test/http_error")

    assert response.status_code == status_code
    assert response.json() == {"detail": error_message}
    mock_log.assert_not_called() 