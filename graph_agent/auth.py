from __future__ import annotations

import contextlib
import logging
import os
from enum import StrEnum
from typing import Any

from fastapi import Depends, HTTPException, Request

logger = logging.getLogger("bpmn.auth")




class Role(StrEnum):
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"


def _is_require_auth() -> bool:
    return os.getenv("REQUIRE_AUTH", "").strip().lower() in ("true", "1", "yes", "on")


_cached_raw_auth_config: tuple[str | None, str, str | None] | None = None
_cached_parsed_auth_config: tuple[str | None, dict[str, Role], bool] | None = None


def parse_auth_config() -> tuple[str | None, dict[str, Role], bool]:
    global _cached_raw_auth_config, _cached_parsed_auth_config
    admin_token = os.getenv("ADMIN_TOKEN")
    api_keys_str = os.getenv("API_KEYS", "")
    require_auth_str = os.getenv("REQUIRE_AUTH")
    current_raw = (admin_token, api_keys_str, require_auth_str)

    if _cached_raw_auth_config == current_raw and _cached_parsed_auth_config is not None:
        return _cached_parsed_auth_config

    api_keys: dict[str, Role] = {}
    for entry in api_keys_str.split(","):
        entry = entry.strip()
        if ":" in entry:
            key, role_str = entry.split(":", 1)
            with contextlib.suppress(ValueError):
                api_keys[key.strip()] = Role(role_str.strip().lower())
        elif entry:
            api_keys[entry] = Role.OPERATOR
    auth_enabled = bool(admin_token or api_keys)

    _cached_raw_auth_config = current_raw
    _cached_parsed_auth_config = (admin_token, api_keys, auth_enabled)
    return _cached_parsed_auth_config


class AuthConfig:
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        self.admin_token, self.api_keys, self.auth_enabled = parse_auth_config()


auth_config = AuthConfig()
_warned_fail_open = False


def get_current_role(request: Request) -> Role | None:
    global _warned_fail_open
    admin_token, api_keys, auth_enabled = parse_auth_config()
    require_auth = _is_require_auth()

    if not auth_enabled:
        if require_auth:
            return None
        if not _warned_fail_open:
            logger.warning(
                "Running in fail-open authentication mode: all requests granted ADMIN role. "
                "Configure ADMIN_TOKEN or API_KEYS for production."
            )
            _warned_fail_open = True
        return Role.ADMIN

    # Check Authorization: Bearer <token>
    auth_header = request.headers.get("authorization") or ""
    bearer = auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else None

    # Check explicit admin token headers, queries, or cookies
    candidate_admin = (
        bearer
        or request.headers.get("x-admin-token")
        or request.query_params.get("admin_token")
        or request.query_params.get("token")
        or request.cookies.get("admin_token")
        or request.cookies.get("token")
    )
    if admin_token and candidate_admin == admin_token:
        return Role.ADMIN

    # Check explicit api key headers, queries, or cookies
    candidate_api_key = (
        request.headers.get("x-api-key")
        or request.query_params.get("api_key")
        or request.cookies.get("api_key")
    )
    if candidate_api_key and candidate_api_key in api_keys:
        return api_keys[candidate_api_key]

    # Fallbacks if a key was passed in token query/cookie or vice versa
    if candidate_admin and candidate_admin in api_keys:
        return api_keys[candidate_admin]
    if admin_token and candidate_api_key == admin_token:
        return Role.ADMIN

    return None





def require_role(*allowed_roles: Role) -> Any:
    # Depends() is itself typed `-> Any`, so this stays assignable as a Role-typed default.
    def checker(role: Role | None = Depends(get_current_role)) -> Role:
        _admin_token, _api_keys, auth_enabled = parse_auth_config()
        require_auth = _is_require_auth()

        if not auth_enabled:
            if require_auth:
                raise HTTPException(
                    status_code=500,
                    detail="REQUIRE_AUTH is enabled but no ADMIN_TOKEN or API_KEYS are configured",
                )
            return Role.ADMIN

        if role is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        if role not in allowed_roles and role != Role.ADMIN:
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required: {[r.value for r in allowed_roles]}",
            )
        return role

    return Depends(checker)
