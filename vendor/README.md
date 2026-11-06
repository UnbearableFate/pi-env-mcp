# Vendored pi packages

Builds of `@earendil-works/pi-env` and `@earendil-works/pi-mcp` from pi's main branch, for features not yet in an npm
release: pi-env's daemon `process` operation with `openProcess()`, and pi-mcp's `PipeTransport`. Made by
`scripts/vendor-pi.sh` from a clean checkout of https://github.com/earendil-works/pi:

| Tarball | Source | Contents |
|---|---|---|
| `earendil-works-pi-env-1.5.0-main.8a19e8c4a.tgz` | pi `8a19e8c4a` (2026-11-06), `packages/env` | `dist/` compiled with TypeScript 7.0.2 against `@earendil-works/chord` and `pi-durable` 1.5.0 from npm; daemons `bin/pi-env-linux-x64` and `bin/pi-env-linux-arm64` built with Rust 1.96.0 (the checkout's `rust-toolchain.toml`) for the musl targets, statically linked |
| `earendil-works-pi-mcp-1.5.0-main.8a19e8c4a.tgz` | pi `8a19e8c4a`, `packages/mcp` | `dist/` compiled with TypeScript 7.0.2 |

Daemons for macOS, Windows and Android are not included: they need their own build machines. Once pi releases these
features, depend on the npm versions again and delete this directory.
