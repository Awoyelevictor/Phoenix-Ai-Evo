from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

SERVICE_NAME = "phoenix-cloud-api"
API_VERSION = "1.0.0"
DEVICE_SELECT = "id,user_id,name,platform,created_at,last_seen_at,revoked_at,credential_hash"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _supabase_config() -> tuple[str, str, str]:
    base_url = _env("SUPABASE_URL").rstrip("/")
    publishable_key = _env("SUPABASE_PUBLISHABLE_KEY")
    secret_key = _env("SUPABASE_SECRET_KEY") or _env("SUPABASE_SERVICE_ROLE_KEY")
    return base_url, publishable_key, secret_key


def _cors_origins() -> list[str]:
    raw = _env("CORS_ALLOWED_ORIGINS")
    return [item.strip().rstrip("/") for item in raw.split(",") if item.strip()]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digest(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=4.0))
    try:
        yield
    finally:
        await app.state.http.aclose()


app = FastAPI(
    title="Phoenix Cloud API",
    version=API_VERSION,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)

_origins = _cors_origins()
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Phoenix-Device-ID", "X-Phoenix-Device-Secret"],
        max_age=600,
    )


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    platform: Literal["android", "windows", "web"]


class AuthenticatedUser(BaseModel):
    id: UUID
    email: str | None = None


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=24000)


class ChatCompletionRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    model: str | None = Field(default=None, min_length=1, max_length=160)
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=1200, ge=1, le=4096)


async def _supabase_auth_user(request: Request, token: str) -> AuthenticatedUser:
    base_url, publishable_key, _ = _supabase_config()
    if not base_url or not publishable_key:
        raise HTTPException(status_code=503, detail="Phoenix cloud authentication is not configured.")
    try:
        response = await request.app.state.http.get(
            f"{base_url}/auth/v1/user",
            headers={"apikey": publishable_key, "Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Authentication provider is temporarily unavailable.")
    if response.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Invalid or expired access token.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Authentication provider is temporarily unavailable.")
    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Unable to verify access token.")
    try:
        payload = response.json()
        return AuthenticatedUser(id=UUID(payload["id"]), email=payload.get("email"))
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=401, detail="Authentication provider returned an invalid user.")


async def current_user(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
) -> AuthenticatedUser:
    if not authorization:
        raise HTTPException(status_code=401, detail="Bearer access token required.")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Bearer access token required.")
    return await _supabase_auth_user(request, token.strip())


async def _admin_request(
    request: Request,
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: dict | None = None,
    prefer: str | None = None,
) -> list | dict | None:
    base_url, _, secret_key = _supabase_config()
    if not base_url or not secret_key:
        raise HTTPException(status_code=503, detail="Phoenix cloud database is not configured.")
    headers = {
        "apikey": secret_key,
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    try:
        response = await request.app.state.http.request(
            method,
            f"{base_url}/rest/v1/{path}",
            params=params,
            json=json,
            headers=headers,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Phoenix cloud database is temporarily unavailable.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Phoenix cloud database is temporarily unavailable.")
    if response.status_code not in (200, 201, 204):
        raise HTTPException(status_code=502, detail="Phoenix cloud database request failed.")
    if response.status_code == 204 or not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Phoenix cloud database returned an invalid response.")


async def _device_record(request: Request, device_id: UUID) -> dict:
    rows = await _admin_request(
        request, "GET", "phoenix_devices",
        params={"id": f"eq.{device_id}", "select": DEVICE_SELECT, "limit": "1"},
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=401, detail="Invalid device credentials.")
    return rows[0]


async def current_device(
    request: Request,
    device_id: Annotated[str | None, Header(alias="X-Phoenix-Device-ID")] = None,
    device_secret: Annotated[str | None, Header(alias="X-Phoenix-Device-Secret")] = None,
) -> dict:
    if not device_id or not device_secret:
        raise HTTPException(status_code=401, detail="Device credentials required.")
    try:
        parsed_id = UUID(device_id)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid device credentials.")
    record = await _device_record(request, parsed_id)
    stored_hash = str(record.get("credential_hash") or "")
    if record.get("revoked_at") is not None or not hmac.compare_digest(stored_hash, _digest(device_secret)):
        raise HTTPException(status_code=401, detail="Invalid or revoked device credentials.")
    await _admin_request(
        request, "PATCH", "phoenix_devices",
        params={"id": f"eq.{parsed_id}", "revoked_at": "is.null"},
        json={"last_seen_at": _now()},
    )
    return record


@app.get("/healthz")
async def healthz():
    base_url, publishable_key, secret_key = _supabase_config()
    configured = bool(base_url and publishable_key and secret_key and _env("OPENROUTER_API_KEY"))
    return {
        "ok": True,
        "service": SERVICE_NAME,
        "version": API_VERSION,
        "status": "ready" if configured else "needs_configuration",
    }


@app.get("/readyz")
async def readyz():
    base_url, publishable_key, secret_key = _supabase_config()
    missing = [
        name for name, value in (
            ("SUPABASE_URL", base_url),
            ("SUPABASE_PUBLISHABLE_KEY", publishable_key),
            ("SUPABASE_SECRET_KEY", secret_key),
        ) if not value
    ]
    if not _env("OPENROUTER_API_KEY"):
        missing.append("OPENROUTER_API_KEY")
    if missing:
        raise HTTPException(status_code=503, detail={"ok": False, "missing_configuration": missing})
    return {"ok": True, "service": SERVICE_NAME}


@app.get("/v1/me")
async def who_am_i(user: Annotated[AuthenticatedUser, Depends(current_user)]):
    return {"id": str(user.id), "email": user.email}


@app.get("/v1/devices")
async def list_devices(
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
):
    rows = await _admin_request(
        request, "GET", "phoenix_devices",
        params={
            "user_id": f"eq.{user.id}",
            "select": "id,name,platform,created_at,last_seen_at,revoked_at",
            "order": "created_at.desc",
        },
    )
    return {"devices": rows if isinstance(rows, list) else []}


@app.post("/v1/devices", status_code=status.HTTP_201_CREATED)
async def register_device(
    body: DeviceCreate,
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
):
    device_secret = secrets.token_urlsafe(40)
    payload = {
        "user_id": str(user.id),
        "name": body.name.strip(),
        "platform": body.platform,
        "credential_hash": _digest(device_secret),
    }
    rows = await _admin_request(
        request, "POST", "phoenix_devices",
        json=payload,
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=502, detail="Device registration did not return a record.")
    record = rows[0]
    return {
        "device": {
            "id": record["id"],
            "name": record["name"],
            "platform": record["platform"],
            "created_at": record["created_at"],
        },
        "device_secret": device_secret,
        "warning": "Save this device secret now. It cannot be retrieved later.",
    }


@app.delete("/v1/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    device_id: UUID,
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
):
    rows = await _admin_request(
        request, "PATCH", "phoenix_devices",
        params={"id": f"eq.{device_id}", "user_id": f"eq.{user.id}", "revoked_at": "is.null"},
        json={"revoked_at": _now()},
        prefer="return=representation",
    )
    if not isinstance(rows, list) or not rows:
        raise HTTPException(status_code=404, detail="Active device not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.get("/v1/device/ping")
async def device_ping(device: Annotated[dict, Depends(current_device)]):
    return {
        "ok": True,
        "device_id": device["id"],
        "name": device["name"],
        "platform": device["platform"],
        "server_time": _now(),
    }



@app.get("/v1/config")
async def public_client_config():
    base_url, publishable_key, _ = _supabase_config()
    if not base_url or not publishable_key:
        raise HTTPException(status_code=503, detail="Phoenix web sign-in is not configured.")
    return {
        "supabase_url": base_url,
        "supabase_publishable_key": publishable_key,
        "api_base_url": "",
    }


@app.get("/", include_in_schema=False)
async def web_app():
    index_file = Path(__file__).resolve().parent.parent / "web_client" / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=503, detail="Phoenix web client is not installed.")
    return FileResponse(index_file)


@app.get("/web-assets/{asset_name}", include_in_schema=False)
async def web_asset(asset_name: str):
    if asset_name not in {"styles.css", "app.js"}:
        raise HTTPException(status_code=404, detail="Asset not found.")
    asset_file = Path(__file__).resolve().parent.parent / "web_client" / asset_name
    if not asset_file.is_file():
        raise HTTPException(status_code=404, detail="Asset not found.")
    return FileResponse(asset_file)


@app.post("/v1/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    request: Request,
    user: Annotated[AuthenticatedUser, Depends(current_user)],
):
    api_key = _env("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="The Phoenix AI provider is not configured.")
    model = body.model or _env("OPENROUTER_MODEL", "openrouter/auto")
    payload = {
        "model": model,
        "messages": [message.model_dump() for message in body.messages],
        "temperature": body.temperature,
        "max_tokens": body.max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": _env("OPENROUTER_SITE_URL", "https://phoenix-cloud-api.onrender.com"),
        "X-Title": "Phoenix AI Evo",
    }
    try:
        response = await request.app.state.http.post(
            OPENROUTER_URL,
            headers=headers,
            json=payload,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="The AI provider took too long to respond.")
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="The AI provider is temporarily unreachable.")

    if response.status_code == 401:
        raise HTTPException(status_code=502, detail="OpenRouter rejected the server API key.")
    if response.status_code == 402:
        raise HTTPException(status_code=402, detail="OpenRouter account has insufficient credits.")
    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="OpenRouter rate limit reached. Try again shortly.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="OpenRouter is temporarily unavailable.")
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail="OpenRouter could not complete this request.")
    try:
        result = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="OpenRouter returned an invalid response.")
    if not isinstance(result, dict) or not isinstance(result.get("choices"), list):
        raise HTTPException(status_code=502, detail="OpenRouter returned an unexpected response.")
    return result
