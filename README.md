# pi-env-mcp

An MCP server that gives Claude Code, Codex and any other MCP agent **persistent access to remote machines over SSH**,
built on the [`pi-env`](https://github.com/earendil-works/pi/tree/main/packages/env) daemon from Pi.

```
┌──────────────────────┐  MCP (stdio)  ┌───────────────────────────┐  one ssh per host   ┌─────────────────────┐
│ Claude Code / Codex  │ ────────────▶ │ pi-env-mcp (this machine) │ ──────────────────▶ │ pi-env daemon       │
│ (any MCP client)     │               │ hosts, cwd, terminals,    │  framed protocol    │ (remote, Rust)      │
└──────────────────────┘               │ jobs, transfers           │  over stdin/stdout  │ files, exec, pty    │
                                       └───────────────────────────┘                     └─────────────────────┘
```

On first use of a host, pi-env detects the remote system, uploads its daemon for that platform (verified by SHA-256,
stored in `~/.pi/mobile/tools/` there) and starts it over `ssh` ([details](#the-pi-env-daemon-on-the-remote-host)).
Every tool call then goes through that one connection: a command costs one round trip (about 2 ms on a LAN) instead of
a new SSH handshake, and state persists between calls. A lost connection is restarted on the next call.

## What persists

| State | Lives in | Survives a dropped connection | Survives a server restart |
|---|---|---|---|
| Working directory of `bash` (`cd` carries over) | this server | yes | no (back to the configured `cwd`) |
| Terminals (`terminal_*`): shell variables, virtualenvs, REPLs | the daemon | no | no |
| Background jobs (`bash` with `run_in_background`) | the remote host | **yes** | **yes** |
| Foreground commands | the daemon | no (killed, reported as lost) | no |

Background jobs run detached from the daemon (in their own session via `setsid -f`, or their own process group), with
their output, pid and exit status under `~/.local/state/pi-env-mcp/jobs/<hostname>/` on the remote host.

## Tools

| Tool | What it does |
|---|---|
| `hosts` | List hosts with connection state, system, working directory, terminals; `connect` / `reconnect` one |
| `bash` | Run a command (bash). Output keeps its end (30 KB / 2000 lines by default), with progress bars collapsed and colors stripped; the complete output is saved on the host. `timeout` (default 120 s), one-off `cwd`, `run_in_background` |
| `read` | Read a text file with line numbers (`offset`, `limit`), or an image (PNG, JPEG, GIF, WebP) |
| `write` | Create or replace a file, creating parent directories |
| `edit` | Exact string replacement (`old_string` → `new_string`, `replace_all`); keeps CRLF and BOM; refuses non-UTF-8 files |
| `glob` | Find files by pattern (`**/*.py`), from the daemon's listing; honors `.gitignore` |
| `grep` | Search contents with ripgrep, or `grep -E` where ripgrep is missing |
| `job_status` | List background jobs, or show one's state and output (tail, or from a byte `offset`); `wait` for it to end |
| `job_kill` | Signal a job's process group (`TERM`, `INT`, `KILL`, ...); `remove` its record |
| `terminal_open` | A login shell in a pseudo-terminal, kept between calls; optionally type a first command |
| `terminal_send` | Type text and named keys (`C-c`, `Up`, `Enter`, ...), wait until the shell is back at its prompt, output goes quiet, or `wait_for` matches |
| `terminal_read` | New output since the last read, or the whole screen (for vim, less, htop) |
| `terminal_close` | Close a terminal |
| `upload` / `download` | Copy files or directory trees between this machine and a host, like `scp -r`: new files appear only once complete; existing files are overwritten in place, keeping their permissions and links |

Terminal output runs through a headless terminal emulator (xterm.js), so the agent reads what a person would see, not
escape sequences. Every tool takes an optional `host`; it defaults to the only configured host, or `defaultHost`.

## Requirements

- Node.js 22.19 or newer on the machine that runs the agent.
- OpenSSH, with key-based login to the remote host (ssh runs in `BatchMode`: no password prompts). An `ssh-agent`, or
  an `IdentityFile` in `~/.ssh/config`, works.
- Remote host: Linux or macOS on x86-64 or arm64, tested on Linux, with `sh`, `uname`, one of `sha256sum`, `shasum` or
  `openssl` (to verify the daemon), and a home directory that may hold programs (not mounted `noexec`). The daemon
  installs itself there ([how](#the-pi-env-daemon-on-the-remote-host)); no root needed. Background jobs need `setsid`
  from util-linux (standard on Linux) or `bash` (macOS has it); `ripgrep` is optional. pi-env also runs on Android
  (Termux) and Windows hosts; those are untested here, and Windows hosts get no terminals or background jobs.

## Install

```sh
cd pi-env-mcp
npm install          # also builds dist/
npm link             # optional: puts `pi-env-mcp` on PATH
```

## Set up a host

```sh
pi-env-mcp add devbox --cwd /home/me/project      # NAME; --host defaults to NAME (an ssh alias works)
pi-env-mcp trust devbox                           # pin its SSH host key
pi-env-mcp check devbox                           # connect, deploy the daemon, report
```

`trust` scans the key the host presents (through the same route real connections take, including `~/.ssh/config`
and jump hosts) and compares it with your own `~/.ssh/known_hosts`: a key you already trust there is accepted at
once; otherwise you confirm the fingerprint (or pass `--yes`). pi-env-mcp keeps its own known-hosts file and never
accepts a changed key by itself (`trust --replace` after you verified the change).

Options of `add`: `--host`, `--user`, `--port`, `--identity`, `--ssh-config`, `--cwd`, `--env KEY=VALUE` (repeatable),
`--no-login-shell`, `--source-bashrc`, `--share-connection`, `--default`. Also: `pi-env-mcp list`,
`pi-env-mcp remove NAME`.

## The pi-env daemon on the remote host

There is nothing to install or start on the remote host yourself, and nothing stays running there between sessions
apart from background jobs: no service, no open port, no root. pi-env-mcp installs the daemon and starts it over `ssh`
whenever it connects, which `pi-env-mcp check NAME` does on purpose and an agent's first tool call does on its own:

```
$ pi-env-mcp check devbox
devbox: connected in 1.5 s (ssh devbox)
  system:      linux x86_64, hostname devbox
  home:        /home/me; working directory /home/me
  daemon:      pi-env 1.4.0 (protocol 1, pid 3811851, features: listFiles)
  ripgrep:     installed
  latency:     1.2 ms per command without a shell, 1.8 ms with bash
```

Each step runs over `ssh`, with the options under [Security notes](#security-notes):

1. **Detect.** `uname -s`, `uname -m` and `$HOME`, asked over ssh, pick the daemon for the host from the
   `@earendil-works/pi-env` package: `bin/pi-env-{linux,darwin,android,windows}-{x64,arm64}/pi-env`, about 2 MB (the
   Linux builds are statically linked, so the host's C library does not matter).
2. **Install.** The daemon lives at `~/.pi/mobile/tools/pi-env-<first 32 hex digits of its SHA-256>` (mode 700). Before
   every start its hash is checked with `sha256sum`, `shasum` or `openssl`; a missing or different file is uploaded
   through ssh's stdin into a temporary file, checked, and renamed into place, and other `pi-env-*` versions in that
   directory are removed. A new pi-env version thus installs itself.
3. **Start.** The remote command is

   ```sh
   exec "$SHELL" -lc 'exec "$0" "$@"' /home/me/.pi/mobile/tools/pi-env-<hash> serve --token <random>
   ```

   Your login shell reads its profile (`~/.profile`, `~/.bash_profile`, `~/.zprofile`, ...) once and replaces itself
   with the daemon, whose environment every command then inherits; with `loginShell: false` (`add --no-login-shell`),
   ssh starts the daemon directly. The daemon answers `PI-ENV <token>` (whatever a startup file prints before that is
   skipped), and from then on the connection's stdin and stdout carry pi-env's
   [framed protocol](https://github.com/earendil-works/pi/blob/main/packages/env/docs/protocol.md): a request per file
   operation, command or terminal input, and a ping every 5 s each way.

A daemon lasts as long as its connection, which serves every tool call for its host: each running server has one per
host, so two agents have two. It ends when the agent quits (the server's stdin closes), when `hosts` reconnects, or when
the connection drops (stdin ends, or 30 s pass without data), and it then kills the commands and terminals it started;
background jobs are detached from it and keep running. The next tool call starts a new daemon, without uploading it
again. To see the daemons on a host:

```
$ ssh devbox 'pgrep -af "[.]pi/mobile/tools/pi-env-"'
3805248 /home/me/.pi/mobile/tools/pi-env-46dde0e25b5cf1a327a10ddcb25f746f serve --token 7db6da42c7b1775b9df267b5b0ba4f04
```

Stop one by ending its connection, not with `kill`: a killed daemon closes its terminals but leaves the commands it was
running behind.

### Starting it by hand

pi-env-mcp does all of the above itself, but each step also works on its own, to provision a host ahead of time or to
see where a failing `check` stops. From the `pi-env-mcp` directory:

```sh
BIN=node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env    # pick the host's system and architecture
NAME=pi-env-$(sha256sum "$BIN" | cut -c1-32)
ssh devbox 'mkdir -p ~/.pi/mobile/tools && chmod 700 ~/.pi/mobile/tools'
scp "$BIN" "devbox:.pi/mobile/tools/$NAME"
ssh devbox "chmod 700 ~/.pi/mobile/tools/$NAME"

ssh devbox "~/.pi/mobile/tools/$NAME --version"                       # pi-env 1.4.0
ssh devbox "~/.pi/mobile/tools/$NAME serve --token test" < /dev/null  # PI-ENV test, then it exits: stdin ended
```

`check` then finds the daemon in place and uploads nothing. Started with stdin left open, the daemon waits for
requests, prints binary ping frames, and exits after 30 s without input.

- Machines that share home directories (such as the nodes of a cluster) share the daemon. Machines of different
  architectures that share a home remove each other's daemon when they install their own, so each uploads it again in
  turn.
- To remove the daemon and the job records from a host: `rm -rf ~/.pi/mobile/tools ~/.local/state/pi-env-mcp`. The
  first is pi-env's own directory, shared by every program built on pi-env; the second holds background jobs' records
  and output.

## Register with an agent

**Claude Code**

```sh
claude mcp add --scope user remote -- pi-env-mcp serve
# without npm link:
claude mcp add --scope user remote -- node /path/to/pi-env-mcp/dist/cli.js serve
```

The tools then appear as `mcp__remote__bash`, `mcp__remote__read`, and so on.

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.remote]
command = "pi-env-mcp"            # or "node" with args = ["/path/to/pi-env-mcp/dist/cli.js", "serve"]
args = ["serve"]
tool_timeout_sec = 3600           # Codex's default of 60 s is shorter than bash's default timeout
```

**Any other MCP client**: run `pi-env-mcp serve` as a stdio server.

One server can offer several hosts (the agent passes `host`), or you can register one server per host, which names the
tools after it: `claude mcp add gpu -- pi-env-mcp serve --host gpu` gives `mcp__gpu__bash`. A `--host` name that is not
configured is used directly as an SSH host or alias (trust it first with `pi-env-mcp trust NAME`).

## Configuration

`~/.config/pi-env-mcp/config.json` (or `$PI_ENV_MCP_HOME`, or `--config-dir`), written by `add`:

```json
{
	"defaultHost": "devbox",
	"hosts": {
		"devbox": {
			"host": "devbox",
			"user": "me",
			"port": 22,
			"identityFile": "~/.ssh/id_ed25519",
			"cwd": "/home/me/project",
			"loginShell": true,
			"sourceBashrc": false,
			"env": { "CUDA_VISIBLE_DEVICES": "0" }
		}
	},
	"output": { "maxBytes": 30000, "maxLines": 2000 },
	"read": { "maxBytes": 40000, "maxLines": 2000 },
	"timeouts": { "default": 120, "max": 3600 }
}
```

- `loginShell` (default true): the daemon starts through your login shell, so commands see the environment of
  `~/.profile` and friends (module systems, conda, `PATH`). It is read once per connection: `hosts` with
  `reconnect: true` picks up changes.
- `sourceBashrc` (default false): Debian and Ubuntu's bash sources `~/.bashrc` before every `bash -c` it believes sshd
  started. The daemon already inherited that environment, so pi-env-mcp sets `SHLVL=1` to skip it, which takes commands
  from ~200 ms to ~2 ms when `~/.bashrc` loads nvm or conda, and keeps its warnings out of the output.

- `shareConnection` (default false): for hosts whose login needs a passphrase without an `ssh-agent`, or a one-time
  password, which ssh's `BatchMode` cannot ask for. pi-env-mcp then connects through the master connection your own
  `~/.ssh/config` keeps open (`ControlMaster auto`, `ControlPath`, `ControlPersist`): open it yourself in a terminal
  with `ssh -fN HOST`, and every connection rides on it without logging in again until it closes. pi-env-mcp asks
  `ssh -G` for the `ControlPath` and runs pi-env's ssh through a wrapper in `<config dir>/ssh/NAME` that names it
  first (ssh keeps the first value of an option, so pi-env's `ControlPath=none` is ignored, while its
  `ControlMaster=no` still keeps pi-env from opening a master itself). Host keys are still trusted with `trust`; the
  master checked the host's key when you opened it.

## Security notes

- The agent can run anything on a configured host as your user. Use your agent's permission settings to decide which
  tools need approval.
- ssh runs with `BatchMode`, strict host-key checking against pi-env-mcp's own known-hosts file under a fixed alias,
  and no agent, X11 or port forwarding, no connection sharing and no `RemoteCommand` (pi-env's defaults).
- The daemon binary is verified by SHA-256 before every start.
- `upload` and `download` read and write local files with the server's permissions; local relative paths are relative
  to the directory the agent started the server in.

## Development

```sh
npm run check                                   # type-check
npm test                                        # unit tests
PI_ENV_MCP_TEST_HOST=devbox npm run test:remote # end-to-end tests against a real host over SSH
npm run build                                   # dist/
node src/cli.ts serve                           # run from source (Node strips the types)
```

The remote tests start the server over stdio with the MCP SDK client and exercise every tool on the host: they work in
the host's own `/tmp`, so transfers really cross machines even where home directories are shared. They run the sources;
`PI_ENV_MCP_TEST_CLI=dist/cli.js` runs them against the build instead.

## Troubleshooting

- **"host key ... is not trusted"**: run `pi-env-mcp trust NAME`.
- **"Permission denied (publickey)"**: ssh cannot log in without a prompt; load the key into `ssh-agent`, set
  `identityFile`, or use `shareConnection` with a master opened by `ssh -fN HOST` in a real terminal (`! ssh ...` in an
  agent has no terminal to ask for the passphrase).
- **"no shared ssh connection to HOST is open"**: the master of a `shareConnection` host closed or expired; open it
  again with `ssh -fN HOST`.
- **A command needs input**: `bash` gives commands an empty stdin; use a terminal (`terminal_open`) for interactive
  programs.
- **Long work times out**: use `run_in_background`, then `job_status` with `wait`.
- **Disk use on the host**: the complete output of truncated commands stays in `/tmp/tmp-*/pi-output-*.log` so the
  agent can read it later (as in Pi); finished background jobs keep their logs until `job_kill` with `remove`.
- **Diagnostics**: `pi-env-mcp serve --verbose` (or `PI_ENV_MCP_DEBUG=1`) logs connections and daemon messages to
  stderr, which agents usually keep in their MCP logs.
