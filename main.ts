// SCRAPLINE — the submission hand-in for threejs-fps-02, rev-2.
//
// The playable game is the game/ folder next to this file: static ES modules
// that load three.js 0.187.0 through an import map, no build step anywhere.
// This script only packages it for the grader: it copies game/ and
// screenshots/ into the output folder and writes dossier.json there using
// the vendored make.fun helper, so the judge can open the screenshots and
// read the source straight from the hand-in.
//
// Usage (Node 22+, standard library only):
//   node main.ts                          writes /output
//   MAKEFUN_OUTPUT_DIR=out node main.ts   writes ./out
// To play before handing in: `node serve.ts`, then open http://localhost:8080.
// The first screenshot alphabetically (1-play.jpg) is the cover image.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const destination = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The grader refuses entries that break its caps, so check the shapes we can
// check here and fail loudly instead of handing in something broken.
const SHOT_LIMIT = 4;
const SHOT_MAX_BYTES = 262144;
const GAME_MAX_FILES = 993;
const GAME_MAX_BYTES = 50331648;

function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = countFiles(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

function handIn() {
  const gameDir = join(here, 'game');
  const shotsDir = join(here, 'screenshots');
  const gameSize = countFiles(gameDir);
  if (gameSize.files > GAME_MAX_FILES) {
    throw new Error(`game/ has ${gameSize.files} files, the cap is ${GAME_MAX_FILES}`);
  }
  if (gameSize.bytes > GAME_MAX_BYTES) {
    throw new Error(`game/ is ${gameSize.bytes} bytes, the cap is ${GAME_MAX_BYTES}`);
  }
  if (!existsSync(shotsDir)) throw new Error('screenshots/ is missing');
  const shots = readdirSync(shotsDir).filter((name) => /\.(jpe?g|png)$/i.test(name)).sort();
  if (shots.length === 0) throw new Error('screenshots/ has no images');
  if (shots.length > SHOT_LIMIT) {
    throw new Error(`${shots.length} screenshots, the cap is ${SHOT_LIMIT}`);
  }
  for (const shot of shots) {
    const size = statSync(join(shotsDir, shot)).size;
    if (size > SHOT_MAX_BYTES) throw new Error(`${shot} is ${size} bytes, the cap is ${SHOT_MAX_BYTES}`);
  }

  mkdirSync(destination, { recursive: true });
  cpSync(gameDir, join(destination, 'game'), { recursive: true });
  mkdirSync(join(destination, 'screenshots'), { recursive: true });
  cpSync(shotsDir, join(destination, 'screenshots'), { recursive: true });

  // text_max_bytes is the one cap that shapes the dossier itself; the rest
  // are refusals for entries the scorer would refuse anyway. game/ shares
  // /output's own 1000-entry cap with screenshots/ and dossier.json, so the
  // file counts above already leave room for them.
  const dossier = buildDossier(destination, {
    text_max_bytes: 163840,
    screenshots: { max: SHOT_LIMIT, max_bytes: SHOT_MAX_BYTES },
    game_max_files: GAME_MAX_FILES,
    game_max_bytes: GAME_MAX_BYTES,
  });
  writeFileSync(join(destination, 'dossier.json'), dossier);
  console.log(
    `handed in ${gameSize.files} game files (${gameSize.bytes} bytes) + ${shots.length} screenshots ` +
      `to ${destination} (cover: ${shots[0]})`,
  );
}

handIn();
