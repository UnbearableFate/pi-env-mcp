"""A small stdio MCP server for the remote tests: no dependencies beyond Python 3.

Tools: echo (text back), info (cwd, an environment variable, its pid), slow (progress every 0.1 s until done or
cancelled), fail (an isError result), quit (exits the process after answering), grow (adds a tool and sends
tools/list_changed). It exits when stdin ends.
"""

import json
import os
import sys
import threading
import time

lock = threading.Lock()
cancelled = set()
extra_tools = []


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def tool(name, description, properties=None, required=None):
    schema = {"type": "object", "properties": properties or {}}
    if required:
        schema["required"] = required
    return {"name": name, "description": description, "inputSchema": schema}


def tools():
    return [
        tool("echo", "Echo text back.", {"text": {"type": "string", "description": "What to echo."}}, ["text"]),
        dict(tool("info", "Where the server runs."), annotations={"readOnlyHint": True}),
        tool("slow", "Report progress until done.", {"steps": {"type": "integer", "minimum": 1}}),
        tool("fail", "Fail with an error result."),
        tool("quit", "Exit the server after answering."),
        tool("grow", "Add a tool."),
    ] + extra_tools


def text(body, is_error=False):
    result = {"content": [{"type": "text", "text": body}]}
    if is_error:
        result["isError"] = True
    return result


def call(request_id, params):
    name = params.get("name")
    args = params.get("arguments") or {}
    token = (params.get("_meta") or {}).get("progressToken")
    if name == "echo":
        return text(args.get("text", ""))
    if name == "info":
        info = {"cwd": os.getcwd(), "var": os.environ.get("FIXTURE_VAR"), "pid": os.getpid(), "argv": sys.argv[1:]}
        return {"content": [{"type": "text", "text": json.dumps(info)}], "structuredContent": info}
    if name == "slow":
        steps = int(args.get("steps", 5))
        for step in range(steps):
            if request_id in cancelled:
                return None
            if token is not None:
                send({"jsonrpc": "2.0", "method": "notifications/progress",
                      "params": {"progressToken": token, "progress": step + 1, "total": steps, "message": f"step {step + 1}"}})
            time.sleep(0.1)
        return text(f"done after {steps} steps")
    if name == "fail":
        return text("it failed", True)
    if name == "quit":
        threading.Timer(0.2, lambda: os._exit(3)).start()
        return text("bye")
    if name == "grow":
        extra_tools.append(tool(f"extra{len(extra_tools) + 1}", "An added tool."))
        send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
        return text("grown")
    return text(f"unknown tool {name}", True)


def handle(message):
    method = message.get("method")
    request_id = message.get("id")
    if method == "notifications/cancelled":
        cancelled.add(message["params"]["requestId"])
        return
    if request_id is None:
        return
    if method == "initialize":
        result = {
            "protocolVersion": message["params"]["protocolVersion"],
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": {"name": "fixture", "version": "1"},
            "instructions": "A fixture for pi-env-mcp's tests.",
        }
    elif method == "tools/list":
        result = {"tools": tools()}
    elif method == "tools/call":
        def run():
            answer = call(request_id, message["params"])
            if answer is not None:
                send({"jsonrpc": "2.0", "id": request_id, "result": answer})
        threading.Thread(target=run, daemon=True).start()
        return
    elif method == "ping":
        result = {}
    else:
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"no method {method}"}})
        return
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


print("fixture starting", file=sys.stderr, flush=True)
for line in sys.stdin:
    line = line.strip()
    if line:
        handle(json.loads(line))
