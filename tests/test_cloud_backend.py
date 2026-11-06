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
