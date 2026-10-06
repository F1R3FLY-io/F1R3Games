#!/bin/sh
# Build the F1R3Games wallet (Rust) to WebAssembly and generate its bindings
# into src/wasm/. Needs the wasm32-unknown-unknown target (rustup target add
# wasm32-unknown-unknown) and wasm-bindgen-cli at the version in Cargo.lock.
#
# On toolchains without a prebuilt wasm32 std (e.g. distribution rustc), set
#   BUILD_STD=1  RUST_LIBRARY_SRC=/path/to/rust/library  WASM_LINKER=wasm-ld
# to build std from source.
set -e
cd "$(dirname "$0")/../.."
if [ -n "$BUILD_STD" ]; then
  RUSTC_BOOTSTRAP=1 __CARGO_TESTS_ONLY_SRC_ROOT="$RUST_LIBRARY_SRC" \
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER="${WASM_LINKER:-wasm-ld}" \
    cargo build -p f1r3games-wallet --features wasm --target wasm32-unknown-unknown --release -Z build-std=std,panic_abort
else
  cargo build -p f1r3games-wallet --features wasm --target wasm32-unknown-unknown --release
fi
wasm-bindgen --target web --out-dir web/src/wasm --out-name f1r3games_wallet \
  target/wasm32-unknown-unknown/release/f1r3games_wallet.wasm
echo "wallet bindings in web/src/wasm/"
