"""Transport: one persistent connection to the drive daemon.

The daemon owns a resident MCP process and answers newline-delimited JSON. This module is the only
place that knows that wire format; everything above it works with tool names and Python dicts.
"""
from __future__ import annotations

import json
import os
import socket
from typing import Any

DEFAULT_HOST = os.environ.get("DRIVER_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("DRIVER_PORT", "8899"))
DEFAULT_TIMEOUT = float(os.environ.get("DRIVER_TIMEOUT", "180"))


class DriverError(RuntimeError):
    """The daemon could not be reached, or it reported a failure."""


class Driver:
    """A line-oriented client for the drive daemon.

    Use it as a context manager so the socket is always closed::

        with Driver() as drv:
            drv.tool("stronghold_state")
    """

    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT, timeout: float = DEFAULT_TIMEOUT):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.buf = b""
        self._next_id = 1
        try:
            self.sock = socket.create_connection((host, port), timeout=timeout)
        except OSError as exc:
            raise DriverError(
                f"cannot reach the drive daemon at {host}:{port} ({exc}). "
                "Start it with: node driver/drive-daemon.mjs"
            ) from exc
        self.sock.settimeout(timeout)

    # ---------------------------------------------------------------- lifecycle
    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def __enter__(self) -> "Driver":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ---------------------------------------------------------------- transport
    def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        req_id = self._next_id
        self._next_id += 1
        payload["id"] = req_id
        self.sock.sendall(json.dumps(payload).encode() + b"\n")
        while True:
            while b"\n" not in self.buf:
                chunk = self.sock.recv(1 << 20)
                if not chunk:
                    raise DriverError("the drive daemon closed the connection")
                self.buf += chunk
            line, self.buf = self.buf.split(b"\n", 1)
            msg = json.loads(line.decode("utf-8", "replace"))
            # Match request id; ignore stale responses from earlier timeouts
            if "id" in msg:
                if msg["id"] == req_id:
                    return msg
                continue
            return msg

    # ---------------------------------------------------------------- API
    def tool(self, name: str, args: dict[str, Any] | None = None, timeout_ms: int | None = None) -> Any:
        """Call one MCP tool and return its ``structuredContent``.

        Raises :class:`DriverError` when the daemon, the MCP server, or the tool call itself failed.
        """
        payload: dict[str, Any] = {"tool": name, "args": args or {}}
        if timeout_ms is not None:
            payload["timeoutMs"] = timeout_ms
        resp = self._request(payload)
        if not resp.get("ok"):
            raise DriverError(f"{name}: {resp.get('error')}")
        return unwrap(resp)

    def raw(self, method: str, params: dict[str, Any] | None = None, timeout_ms: int | None = None) -> Any:
        """Call an arbitrary MCP method (e.g. ``tools/list``) and return its JSON-RPC ``result``.

        The daemon forwards the MCP server's whole JSON-RPC envelope, so the ``result`` field is
        unwrapped here — a caller should never have to know about the transport's nesting.
        """
        payload: dict[str, Any] = {"method": method, "params": params or {}}
        if timeout_ms is not None:
            payload["timeoutMs"] = timeout_ms
        resp = self._request(payload)
        if not resp.get("ok"):
            raise DriverError(f"{method}: {resp.get('error')}")
        envelope = resp.get("result")
        if isinstance(envelope, dict):
            if envelope.get("error") is not None:
                raise DriverError(f"{method}: {envelope['error']}")
            if "result" in envelope:
                return envelope["result"]
        return envelope

    def tools(self) -> list[dict[str, Any]]:
        """Every tool the MCP server exposes."""
        result = self.raw("tools/list") or {}
        return result.get("tools") or []


def unwrap(resp: dict[str, Any]) -> Any:
    """An MCP tool reply -> its structured content (or the parsed text content)."""
    result = resp.get("result") or {}
    structured = result.get("structuredContent")
    if structured is not None:
        return structured
    try:
        return json.loads(result["content"][0]["text"])
    except Exception as exc:  # noqa: BLE001 - the reply shape is the server's, not ours
        raise DriverError(f"unparsable tool result: {exc}") from exc
