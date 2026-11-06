from fastapi.testclient import TestClient

from cloud_backend.app import app


def clear_supabase_env(monkeypatch):
    for key in ("SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"):
        monkeypatch.delenv(key, raising=False)


def test_health_is_public_and_does_not_leak_configuration(monkeypatch):
    clear_supabase_env(monkeypatch)
    with TestClient(app) as client:
        response = client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["status"] == "needs_configuration"
    assert "SUPABASE_URL" not in str(body)


def test_readiness_reports_missing_configuration(monkeypatch):
    clear_supabase_env(monkeypatch)
    with TestClient(app) as client:
        response = client.get("/readyz")
    assert response.status_code == 503
    assert set(response.json()["detail"]["missing_configuration"]) == {
        "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"
    }


def test_protected_routes_reject_missing_bearer_token():
    with TestClient(app) as client:
        response = client.get("/v1/me")
    assert response.status_code == 401
    assert response.json()["detail"] == "Bearer access token required."


def test_device_ping_rejects_missing_device_credentials():
    with TestClient(app) as client:
        response = client.get("/v1/device/ping")
    assert response.status_code == 401
    assert response.json()["detail"] == "Device credentials required."


def test_readiness_requires_openrouter_key_when_supabase_is_configured(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable-placeholder")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "secret-placeholder")
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with TestClient(app) as client:
        response = client.get("/readyz")
    assert response.status_code == 503
    assert response.json()["detail"]["missing_configuration"] == ["OPENROUTER_API_KEY"]


def test_chat_requires_openrouter_key(monkeypatch):
    from cloud_backend.app import AuthenticatedUser, current_user
    import uuid

    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    app.dependency_overrides[current_user] = lambda: AuthenticatedUser(id=uuid.uuid4())
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/chat/completions",
                json={"messages": [{"role": "user", "content": "Hello"}]},
            )
        assert response.status_code == 503
    finally:
        app.dependency_overrides.clear()
