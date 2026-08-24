#!/usr/bin/env bash
#
# Downloads the themed GLB props used to dress the four zones.
# The scene runs fine without them — they are pure decoration layered on top of
# the procedural geometry.
#
#   ./tools/fetch-models.sh   # download into assets/Models/
#   npm run gen:world         # regenerate the composite (models are included by default now)
#
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p assets/Models

fetch() {
  local name="$1" url="$2"
  if [ -s "assets/Models/${name}.glb" ]; then
    echo "  skip  ${name}.glb (already present)"
    return
  fi
  echo "  get   ${name}.glb"
  curl -fsSL -o "assets/Models/${name}.glb" "$url"
  # A curl that quietly saved an HTML error page is worse than a missing file.
  if [ "$(head -c 4 "assets/Models/${name}.glb")" != "glTF" ]; then
    echo "  !! ${name}.glb is not a glTF file — removing" >&2
    rm -f "assets/Models/${name}.glb"
    return 1
  fi
}

echo "Jungle Labyrinth"
fetch jungle-plant-06 "https://models.dclregenesislabs.xyz/blobs/bafkreibvziq44clff6b472xjcmjri76vaif5u4u3xuhp2hb2lgcz7gplzi"
fetch fern            "https://models.dclregenesislabs.xyz/blobs/bafkreickwhyunlgy2tmx3fbwszfyk4izoglhnrd55bbxnwri2dqqspnh34"
fetch parque          "https://models.dclregenesislabs.xyz/blobs/bafkreieazwk3tj7qonoywocjih44dg34tghpksvla34nlpyb6wjck4wovu"
# "Mountain Ragweed" from Decentraland's own built-in Creator Hub asset
# library (@dcl/asset-packs, "Fantasy" pack) — a bush-styled prop, fetched
# from the public catalyst content server by its content hash (see
# node_modules/@dcl/asset-packs/catalog.json for the full nature/tree/bush
# catalog this came from). Just for a look/comparison — not wired into
# gen-world.mjs yet.
fetch mountain-ragweed "https://peer.decentraland.org/content/contents/bafkreicx77vphz47xqtqafmrxkwnnoede7jgh6ax2qhmvfl6bb2pmck4e4"

echo "The Foundry"
fetch wm-barrel-glb   "https://models.dclregenesislabs.xyz/blobs/bafkreic5n62e4p4qas37cy4f6bmctuesduqp7ethmoxp76e5kg5xy346hy"
fetch crate           "https://models.dclregenesislabs.xyz/blobs/bafkreied5y23h6xtxh2udisbaap2zidnitpvlxigvjxydv3pemxadwtxz4"

echo "Sunken Tomb"
fetch statue          "https://models.dclregenesislabs.xyz/blobs/bafkreigz5fwg3so5djnguynpklqgoeh7wnwiqwh2kxk2gkws36nqxvjxau"
fetch pebble-03       "https://models.dclregenesislabs.xyz/blobs/bafkreiaii7xh4537ko3ed45362bu6vz2telwhgmhfxqtkmsvfzknbku6fu"

echo "Frozen Peaks"
fetch pine            "https://models.dclregenesislabs.xyz/blobs/bafybeidb3pyhnod6mwbo2nfy4cfa6kmkff5yolul6q67mfde2jxv3j5mti"
fetch cp6             "https://models.dclregenesislabs.xyz/blobs/bafkreiepvoikajj6lhwotlpjx7dp2d36fjmryytt3qwueylkfb2766cvly"
fetch cp8             "https://models.dclregenesislabs.xyz/blobs/bafkreicmhqturkjxqpb2o5ngisoj3zosnbd2n73tlnakfylpt3ydh3vjym"

echo
echo "Done. Now run:  npm run gen:world"
