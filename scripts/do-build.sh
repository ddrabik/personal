#!/usr/bin/env bash
# The build command for DigitalOcean App Platform.
#
# The app's static site component was created as a plain HTML site, whose
# build container has no Node. Rather than depend on the component being
# switched to the Node.js buildpack, this fetches Node itself when it is
# missing, then runs the normal build.
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64 | arm64) arch=arm64 ;;
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac

    base=https://nodejs.org/dist/latest-v22.x
    work=$(mktemp -d)
    curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
    # The line for this platform's tarball: "<sha256>  node-v22.x.y-linux-x64.tar.gz".
    line=$(grep "linux-$arch.tar.gz\$" "$work/SHASUMS256.txt")
    file=${line##* }
    curl -fsSL --retry 3 "$base/$file" -o "$work/$file"
    (cd "$work" && echo "$line" | sha256sum -c -)
    mkdir -p "$work/node"
    tar -xzf "$work/$file" -C "$work/node" --strip-components=1
    export PATH="$work/node/bin:$PATH"
    echo "Fetched Node $(node --version)"
fi

npm ci
npm run build
