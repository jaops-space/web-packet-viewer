#!/bin/sh
# Generates the Java outputs compared by `cargo test --test golden`, with the Java packet viewer code:
# - target/golden.txt: the packet-viewer quickstart MDB and test data (from the packet-viewer distribution);
# - target/golden-pus.txt and target/golden-pus.xml (the XTCE export of the plugin): the PUS simulator MDB of
#   dev/yamcs and packets recorded from it (pus/packets.raw).
# Needs a packet-viewer distribution (yamcs/distribution/target/packet-viewer-*.tar.gz).
set -e
here=$(cd "$(dirname "$0")" && pwd)
dist=${1:-$HOME/git/yamcs/distribution/target/packet-viewer-5.14.1.tar.gz}
target=$here/../../target
out=$target/golden
rm -rf "$out" && mkdir -p "$out"
tar xzf "$dist" -C "$out" --strip-components=1
cd "$out"
java -cp "etc:lib/*" "$here/Golden.java" quickstart tm-data/testdata.ccsds "$here/filters.txt" > "$target/golden.txt"
cd "$here/../../dev/yamcs/src/main/yamcs"
java -cp "$here/pus/etc:$out/lib/*" "$here/Golden.java" pus "$here/pus/packets.raw" "$here/pus/filters.txt" \
  "$target/golden-pus.xml" > "$target/golden-pus.txt"
