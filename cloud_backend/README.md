# Phoenix Cloud API

A separate FastAPI service for the Phoenix web, Android, and Windows clients. It does not import or execute the original desktop application.

## Runtime

- Python 3.12+
- FastAPI + Uvicorn
- Supabase Auth for user identity
- Supabase PostgREST for the private device registry

## Local run

    python -m venv .venv
    pip install -r requirements-cloud.txt
    uvicorn cloud_backend.app:app --host 0.0.0.0 --port 8000

The service starts without Supabase credentials so the public health endpoint can be checked. Authenticated endpoints remain unavailable until the server environment is configured. The chat endpoint additionally requires `OPENROUTER_API_KEY`; it uses `OPENROUTER_MODEL` or defaults to `openrouter/auto`.

## Environment

Set these only in Render's secret environment settings:

- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SECRET_KEY

SUPABASE_SERVICE_ROLE_KEY is accepted as a temporary legacy fallback for SUPABASE_SECRET_KEY. Prefer a new Supabase secret key. Never put a secret/service-role key in a browser, Android APK, Windows client, Git commit, or public build argument.

Set CORS_ALLOWED_ORIGINS to a comma-separated list of exact trusted web origins. Do not use a wildcard for production.

## Routes

- GET /healthz — public liveness check; never returns secrets
- GET /readyz — verifies required configuration is present
- POST /v1/chat/completions — authenticated OpenRouter chat completion proxy; the API key stays server-side\n- GET /v1/me — verifies the Supabase access token with Supabase Auth
- GET /v1/conversations — list the signed-in user's active conversations
- POST /v1/conversations — create a conversation
- GET /v1/conversations/{id}/messages — load saved messages
- POST /v1/conversations/{id}/messages — append a user or assistant message
- DELETE /v1/conversations/{id} — archive an owned conversation
- GET /v1/devices — list devices owned by the signed-in user
- POST /v1/devices — register a device; the generated secret is returned once
- DELETE /v1/devices/{id} — revoke an owned device
- GET /v1/device/ping — authenticate a paired device using its ID and secret

Device credentials are stored as SHA-256 digests; raw credentials are only returned at creation. Device ownership is checked on every user-scoped operation. Revocation is persistent.

## Database setup

Apply supabase/migrations/20261106000100_phoenix_devices.sql to the existing ULTRON Supabase project selected for Phoenix AI Evo before configuring the API. The migration enables RLS and denies direct access to anon and authenticated; only the server-side service role can access the table. The API performs ownership checks after verifying each user with Supabase Auth. The existing ULTRON project name and project ID remain unchanged; Phoenix uses its existing Supabase URL and keys. Apply the conversation migration `20261106000200_phoenix_conversation_memory.sql` as well. Both conversation tables have RLS enabled, direct anon/authenticated table access revoked, and service-role-only grants. The API verifies the signed-in Supabase user and filters every read/write by that user ID.

## Browser client\n\nThe cloud service serves the Phoenix browser workspace at `/`. The static client lives in `web_client/`, signs users in through Supabase Auth, and sends chat requests to the authenticated cloud API. The OpenRouter secret never reaches the browser. Conversation history is stored in ULTRON and reloaded after sign-in, so the browser can resume saved chats. Cross-device integration still requires the Android and Windows clients to use the same conversation API.\n\n## Deployment

Render should deploy this branch with:

- Build: pip install -r requirements-cloud.txt
- Start: uvicorn cloud_backend.app:app --host 0.0.0.0 --port $PORT
- Health path: /healthz

The service is intentionally separate from main.py, PyQt6, Windows automation, and the desktop dependency set.
