from __future__ import annotations

import logging
import os
from enum import Enum
from typing import Optional

from fastapi import Depends, HTTPException, Header, Request

logger = logging.getLogger("bpmn.auth")


class Role(str, Enum):
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
            try:
                api_keys[key.strip()] = Role(role_str.strip().lower())
            except ValueError:
                pass
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


def get_current_role(
    x_api_key: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> Role | None:
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

    if admin_token and x_admin_token == admin_token:
        return Role.ADMIN

    if x_api_key and x_api_key in api_keys:
        return api_keys[x_api_key]

    return None


def require_role(*allowed_roles: Role):
    def checker(role: Role | None = Depends(get_current_role)) -> Role:
        admin_token, api_keys, auth_enabled = parse_auth_config()
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
