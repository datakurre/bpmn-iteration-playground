from __future__ import annotations

import os
from enum import Enum
from typing import Optional

from fastapi import Depends, HTTPException, Header, Request


class Role(str, Enum):
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"


class AuthConfig:
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        self.admin_token = os.getenv("ADMIN_TOKEN")
        self.api_keys: dict[str, Role] = {}
        api_keys_str = os.getenv("API_KEYS", "")
        for entry in api_keys_str.split(","):
            entry = entry.strip()
            if ":" in entry:
                key, role_str = entry.split(":", 1)
                try:
                    self.api_keys[key.strip()] = Role(role_str.strip().lower())
                except ValueError:
                    pass
            elif entry:
                self.api_keys[entry] = Role.OPERATOR
        self.auth_enabled = bool(self.admin_token or self.api_keys)


auth_config = AuthConfig()


def get_current_role(
    x_api_key: Optional[str] = Header(default=None),
    x_admin_token: Optional[str] = Header(default=None),
) -> Role | None:
    # Always reload dynamically to support runtime env changes in tests/config
    admin_token = os.getenv("ADMIN_TOKEN")
    api_keys_str = os.getenv("API_KEYS", "")
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
    if not auth_enabled:
        return Role.ADMIN  # No auth configured -> unrestricted access

    if admin_token and x_admin_token == admin_token:
        return Role.ADMIN

    if x_api_key and x_api_key in api_keys:
        return api_keys[x_api_key]

    return None


def require_role(*allowed_roles: Role):
    def checker(role: Role | None = Depends(get_current_role)) -> Role:
        admin_token = os.getenv("ADMIN_TOKEN")
        api_keys_str = os.getenv("API_KEYS", "")
        auth_enabled = bool(admin_token or api_keys_str)

        if not auth_enabled:
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
