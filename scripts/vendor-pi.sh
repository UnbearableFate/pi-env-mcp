#!/bin/sh
# Build @earendil-works/pi-env and @earendil-works/pi-mcp from a checkout of earendil-works/pi and pack them into
# vendor/, for features that are on pi's main branch but not released on npm yet (pi-env's `process` operation,
# pi-mcp's PipeTransport). Once a release has them, depend on the npm versions again and delete vendor/.
#
#   scripts/vendor-pi.sh [PI_CHECKOUT]       default: ../pi
#
# Needs Node and the Rust toolchain the checkout pins (rustup installs it), with the musl targets the daemons are
# built for. Builds the Linux daemons only (x86-64 and arm64, statically linked like pi's releases); other systems'
# daemons need their own build machines (see pi's .github/workflows/env-daemons.yml).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
pi=$(cd "${1:-$here/../pi}" && pwd)
commit=$(git -C "$pi" rev-parse --short=9 HEAD)
if [ -n "$(git -C "$pi" status --porcelain -- packages/env packages/mcp)" ]; then
	echo "vendor-pi: $pi has uncommitted changes in packages/env or packages/mcp" >&2
	exit 1
fi
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
export PATH="$HOME/.cargo/bin:$PATH"

# The daemons, as pi's env-daemons workflow builds them.
(
	cd "$pi/packages/env/daemon"
	toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
	rustup target add --toolchain "$toolchain" x86_64-unknown-linux-musl aarch64-unknown-linux-musl >/dev/null
	export CARGO_TARGET_DIR="$stage/target"
	# Pure Rust and statically linked: rust-lld links the arm64 build without a cross C toolchain.
	export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
	cargo build --release --locked --target x86_64-unknown-linux-musl
	cargo build --release --locked --target aarch64-unknown-linux-musl
)

# Each package compiled on its own against the npm releases of its dependencies.
build() {
	name=$1
	src="$pi/packages/$name"
	dir="$stage/$name"
	mkdir -p "$dir"
	cp -R "$src/src" "$src/package.json" "$src/README.md" "$src/CHANGELOG.md" "$dir/"
	for extra in docs THIRD_PARTY_NOTICES; do
		if [ -e "$src/$extra" ]; then cp -R "$src/$extra" "$dir/"; fi
	done
	# The published version is marked as a build of this commit; the package's own @types devDependencies and pi's
	# TypeScript compile it, and the manifest is left without scripts or devDependencies.
	types=$(node - "$dir/package.json" "$commit" <<-'EOF'
		const fs = require("node:fs");
		const [file, commit] = process.argv.slice(2);
		const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
		const types = Object.entries(pkg.devDependencies ?? {})
			.filter(([name]) => name.startsWith("@types/"))
			.map(([name, version]) => `${name}@${version}`);
		pkg.version = `${pkg.version}-main.${commit}`;
		delete pkg.scripts;
		delete pkg.devDependencies;
		fs.writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
		process.stdout.write(types.join(" "));
	EOF
	)
	compiler=$(node -p 'const p = require(process.argv[1]); p.devDependencies.typescript' "$pi/package.json")
	nodeTypes=$(node -p 'const p = require(process.argv[1]); p.devDependencies["@types/node"]' "$pi/package.json")
	cp "$pi/tsconfig.base.json" "$stage/tsconfig.base.json"
	cat >"$dir/tsconfig.json" <<-'EOF'
		{
			"extends": "../tsconfig.base.json",
			"compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
			"include": ["src/**/*.ts"]
		}
	EOF
	(
		cd "$dir"
		# shellcheck disable=SC2086 # one word per package
		npm install --no-save --no-package-lock --ignore-scripts --no-audit --no-fund --loglevel=error \
			"typescript@$compiler" "@types/node@$nodeTypes" $types >/dev/null
		npx tsc -p tsconfig.json
		rm -rf node_modules tsconfig.json
	)
}

build env
mkdir -p "$stage/env/bin/pi-env-linux-x64" "$stage/env/bin/pi-env-linux-arm64"
cp "$stage/target/x86_64-unknown-linux-musl/release/pi-env" "$stage/env/bin/pi-env-linux-x64/pi-env"
cp "$stage/target/aarch64-unknown-linux-musl/release/pi-env" "$stage/env/bin/pi-env-linux-arm64/pi-env"
build mcp

mkdir -p "$here/vendor"
rm -f "$here"/vendor/earendil-works-pi-env-*.tgz "$here"/vendor/earendil-works-pi-mcp-*.tgz
(cd "$stage/env" && npm pack --silent --pack-destination "$here/vendor")
(cd "$stage/mcp" && npm pack --silent --pack-destination "$here/vendor")
echo "vendored pi $commit:"
ls -l "$here"/vendor/*.tgz
