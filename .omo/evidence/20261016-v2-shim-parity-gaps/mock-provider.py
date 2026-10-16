#!/usr/bin/env python3
"""OpenAI-compatible mock provider for the V2 shim parity probes.

This is the 2.0.30 recheck mock (`.omo/evidence/20261016-opencode-2030-recheck/
mock-provider.py`) plus one capability the shim probes need: answering with an
OpenAI `tool_calls` turn, so the host executes a probe tool that calls the
PRODUCTION shim against a REAL V2 plugin context.

Why a copy instead of an edit: the recheck directory is a committed record of a
finished run; its captures must stay reproducible against the script that
produced them.

Tools are only offered when `--tool-call` is set AND the request has no
`role:"tool"` message yet (i.e. the first model call of a turn), and only when
`--tool-call-marker` is unset or appears in the last user message. The marker
lets one server drive a plain turn on one session and a tool-calling turn on
another.

Usage:
  mock-provider.py --port 8123 --log /tmp/bodies.jsonl [--reply TEXT]
                   [--summary-file PATH] [--prompt-tokens N]
                   [--completion-tokens N] [--delay-seconds S]
                   [--tool-call NAME] [--tool-args JSON] [--tool-call-marker S]
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None


def approx_tokens(text):
    # Deliberately crude: the probes only need a monotonic size signal.
    return max(1, len(text) // 4)


def last_user_text(body):
    for message in reversed(body.get("messages") or []):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        return json.dumps(content)
    return ""


def should_tool_call(body):
    if not ARGS.tool_call:
        return False
    for message in body.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "tool":
            return False
    if ARGS.tool_call_marker:
        return ARGS.tool_call_marker in last_user_text(body)
    return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep stdout clean for the probe script
        pass

    def _record(self, body_text, decision):
        with open(ARGS.log, "a") as fh:
            fh.write(json.dumps({"path": self.path, "decision": decision, "raw": body_text}) + "\n")
            fh.flush()

    def _json(self, payload, status=200):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "mock-1",
                            "object": "model",
                            "created": int(time.time()),
                            "owned_by": "mock",
                        }
                    ],
                }
            )
            return
        self._json({"error": {"message": "not found"}}, status=404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        if ARGS.delay_seconds:
            # A slow reply keeps a turn in flight, so a probe can watch the host
            # keep reporting that session as busy for longer than the background
            # manager's ~9s "session gone" window (see v2/session-activity.ts).
            time.sleep(ARGS.delay_seconds)
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        calling = should_tool_call(body)
        self._record(raw, "tool_call" if calling else "text")
        stream = bool(body.get("stream"))
        model = body.get("model") or "mock-1"
        reply = ARGS.reply
        if ARGS.summary_file:
            # The host asks for a template-shaped summary in three phrasings: the
            # first summary, a checkpoint update, and a retry after a mismatch.
            markers = (
                "summarize the conversation above",
                "update the existing checkpoint",
                "summary template",
            )
            for message in body.get("messages") or []:
                if not isinstance(message, dict):
                    continue
                content = message.get("content")
                if isinstance(content, str) and any(m in content.lower() for m in markers):
                    reply = open(ARGS.summary_file).read()
                    break
        prompt_tokens = ARGS.prompt_tokens
        if prompt_tokens < 0:
            chars = sum(
                len(str(m.get("content", "")))
                for m in (body.get("messages") or [])
                if isinstance(m, dict)
            )
            prompt_tokens = approx_tokens("x" * chars)
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": ARGS.completion_tokens,
            "total_tokens": prompt_tokens + ARGS.completion_tokens,
        }
        cid = "chatcmpl-mock-%d" % int(time.time() * 1000)
        args = ARGS.tool_args
        tool_calls = []
        if calling:
            tool_calls = [
                {
                    "index": 0,
                    "id": "call_mock_%d" % int(time.time() * 1000),
                    "type": "function",
                    "function": {"name": ARGS.tool_call, "arguments": args},
                }
            ]

        if not stream:
            message = {"role": "assistant", "content": None if calling else reply}
            finish = "stop"
            if calling:
                message["content"] = None
                message["tool_calls"] = tool_calls
                finish = "tool_calls"
            self._json(
                {
                    "id": cid,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                    "usage": usage,
                }
            )
            return

        # SSE: two content chunks plus a terminal chunk carrying usage.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        def chunk(delta, finish_reason=None):
            return {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            }

        if calling:
            # An OpenAI-compatible tool-call stream: announce the call, then close
            # the turn with finish_reason "tool_calls" (the host executes it and
            # calls back with the tool result, which gets the plain reply branch).
            events = [
                chunk({"role": "assistant", "content": None, "tool_calls": tool_calls}),
                chunk({}, "tool_calls"),
            ]
        else:
            half = max(1, len(reply) // 2)
            events = [
                chunk({"role": "assistant", "content": reply[:half]}),
                chunk({"content": reply[half:]}),
                chunk({}, "stop"),
            ]
        events[-1]["usage"] = usage
        for event in events:
            self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main():
    global ARGS
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", required=True)
    parser.add_argument("--reply", default="MOCK_OK")
    parser.add_argument("--summary-file", default="")
    # -1 means "estimate from the request messages".
    parser.add_argument("--prompt-tokens", type=int, default=-1)
    parser.add_argument("--completion-tokens", type=int, default=4)
    # Applies to every completion; 0 keeps the fast probes instant.
    parser.add_argument("--delay-seconds", type=float, default=0.0)
    parser.add_argument("--tool-call", default="")
    parser.add_argument("--tool-args", default="{}")
    parser.add_argument("--tool-call-marker", default="")
    ARGS = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print("MOCK_READY port=%d log=%s" % (ARGS.port, ARGS.log), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
