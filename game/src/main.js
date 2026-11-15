// SCRAPLINE rev-2 — boot, the fixed-step loop, and the round glue.
//
// This is the file that ties the modules together. Each module owns one job
// (world, player, weapons, bots, rounds, grenades, effects, audio, HUD), and
// this file owns everything that crosses between them: shooting a ray and
// turning a hit into damage, planting the spike, the buy menu, dying and
// spectating a teammate, and restarting the match.
//
// Simulation runs at a fixed 60 Hz and renders at the display rate, so the
// game feels the same on any monitor. Rev-2 additions here: the minimap and
// scoreboard with MVP, floating damage numbers, the living yard, health
// regen after six quiet seconds, a spectator camera for the dead, settings
// that survive a reload — and new in this pass, kill-streak bonuses, a
// clutch callout when the player is the last attacker standing, and a
// match-point banner.
//
// Deterministic captures for the dossier: ?shot=start|play|buy|end with
// &seed=N sets a fixed frame, paints it twice, freezes, and sets
// window.__shotReady so a screenshot tool knows when to fire.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createMinimap } from './minimap.js';
import { createScoreboard } from './scoreboard.js';
import { createDamageFx } from './damagefx.js';
import { createAmbient } from './ambient.js';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createInput } from './input.js';
import { createWeapon, WEAPONS, WEAPON_ORDER } from './weapon.js';
import { createBots } from './bots.js';
import { createRounds } from './rounds.js';
import { createGrenades } from './grenade.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';

// ---- Tuning that lives here (module-owned numbers live in their modules) ----
const STEP = 1 / 60; // fixed simulation step
const PLANT_TIME = 3.5; // seconds of holding E inside a site
const REGEN_WAIT = 6; // quiet seconds before health starts coming back
const REGEN_SPEED = 12; // health per second while regenerating
const FIRST_BLOOD = 100; // bonus money for the round's first kill
const STREAK_BONUS = [0, 0, 100, 200, 400]; // money for a 2/3/4+ kill streak

const query = new URLSearchParams(window.location.search);
const shotName = query.get('shot');
const shotSeed = Number.parseInt(query.get('seed') ?? '1', 10) || 1;

// Seeded RNG so captures are reproducible: same seed, same bot spawns.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(shotSeed);

// ---- Persistent player settings (sensitivity, volume, crosshair colour) ----
const SETTINGS_STORE = 'scrapline-settings-v2';
const settings = { sensitivity: 1, volume: 0.35, crosshair: '#e9e2d2' };
try {
  const stored = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}');
  if (typeof stored.sensitivity === 'number') settings.sensitivity = stored.sensitivity;
  if (typeof stored.volume === 'number') settings.volume = stored.volume;
  if (typeof stored.crosshair === 'string') settings.crosshair = stored.crosshair;
} catch {
  // No saved profile (or private mode): the defaults above stand.
}
function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_STORE, JSON.stringify(settings));
  } catch {
    // Private mode: settings only live for this session.
  }
}

// ---- Renderer, scene, camera ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 26, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

// ---- Wire the modules together ----
const audio = createAudio();
audio.setVolume(settings.volume);
const world = createWorld(scene);
const effects = createEffects(scene);
const hud = createHud();
const minimap = createMinimap(hud.minimapCanvas);
const scoreboard = createScoreboard();
const damageFx = createDamageFx(hud.damageContainer, hud.damageArc);
const ambient = createAmbient(scene, world.anchors);
const player = createPlayer(world.colliders);
const weapon = createWeapon(camera, audio);
const input = createInput(renderer.domElement, onPointerLock);
const raycaster = new THREE.Raycaster();
raycaster.far = 90;
const aimDir = new THREE.Vector3();
const muzzlePos = new THREE.Vector3();
const YOU = { name: 'YOU', team: 'attack' };

hud.onSettings((key, value) => {
  if (key === 'sensitivity') settings.sensitivity = value;
  if (key === 'volume') {
    settings.volume = value;
    audio.setVolume(value);
  }
  if (key === 'crosshair') settings.crosshair = value;
  persistSettings();
});
document.getElementById('crosshair').style.setProperty('--cross-color', settings.crosshair);

// ---- The match state: everything the loop reads and writes ----
const match = {
  health: 100,
  playerAlive: true,
  kills: 0,
  streak: 0,
  clutchCalled: false,
  frozen: false,
  plantProgress: 0,
  plantSite: null,
  buyOpen: false,
  suppressPause: false,
  wasFiring: false,
  elapsed: 0,
  lastDamageAt: -99,
  lastHeartbeat: -99,
  spectateIndex: 0,
  tabWasHeld: false,
  grenadeNear: false,
};
const body = player.state;

// ---- The spike: a small blinking box that appears where the plant lands ----
const spikeLight = new THREE.PointLight(new THREE.Color('#ff2e1f'), 0, 9, 1.8);
scene.add(spikeLight);
const spikeMesh = new THREE.Group();
{
  const casing = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.22, 0.34),
    new THREE.MeshStandardMaterial({ color: new THREE.Color('#14161a'), roughness: 0.5, metalness: 0.5 }),
  );
  casing.position.y = 0.11;
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 10, 8),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff2e1f') }),
  );
  beacon.position.y = 0.26;
  spikeMesh.add(casing, beacon);
  spikeMesh.visible = false;
  scene.add(spikeMesh);
}

function plantedPos() {
  return rounds.state.planted ? rounds.state.planted.pos : new THREE.Vector3();
}
function revealSpike() {
  const pos = rounds.state.planted.pos;
  spikeMesh.position.copy(pos);
  spikeMesh.visible = true;
  spikeLight.position.set(pos.x, 1.2, pos.z);
}
function concealSpike() {
  spikeMesh.visible = false;
  spikeLight.intensity = 0;
}

// ---- Round flow: what the HUD, the scoreboard and the bots hear ----
const rounds = createRounds({
  onRoundStart(n) {
    respawnEveryone();
    const matchPoint = rounds.state.wins.attack === 4 || rounds.state.wins.defend === 4;
    hud.banner(
      matchPoint ? 'MATCH POINT' : `ROUND ${n}`,
      matchPoint
        ? 'One round decides the match'
        : n === 1 ? 'Plant the spike at A or B' : 'Buy up — press B',
      2200,
    );
    hud.hideBuy();
  },
  onLiveStart() {
    hud.banner('GO', 'Eliminate EMBER or plant the spike', 1200);
  },
  onRoundEnd(winner, reason) {
    const attackersWon = winner === 'attack';
    hud.banner(attackersWon ? 'VANGUARD WINS THE ROUND' : 'EMBER WINS THE ROUND', reason, 3200);
    if (attackersWon) audio.roundWin();
    else audio.roundLose();
    hud.setScore(rounds.state.wins.attack, rounds.state.wins.defend);
    scoreboard.recordRound(winner);
    hud.setRoundPips(scoreboard.rounds());
    concealSpike();
  },
  onMatchEnd(winner) {
    const mvp = scoreboard.mvp();
    const scoreLine = winner === 'attack'
      ? `VANGUARD ${rounds.state.wins.attack} — ${rounds.state.wins.defend} EMBER. The yard is yours.`
      : winner === 'defend'
        ? `EMBER ${rounds.state.wins.defend} — ${rounds.state.wins.attack} VANGUARD. The yard holds.`
        : `Draw ${rounds.state.wins.attack} — ${rounds.state.wins.defend}.`;
    const mvpLine = mvp ? ` MVP: ${mvp.name} — ${mvp.kills} kills, ${mvp.damage} damage.` : '';
    hud.showOverlay('match', scoreLine + mvpLine);
    hud.showScoreboard(scoreboard.table(), 'MATCH SUMMARY');
    if (document.pointerLockElement) document.exitPointerLock();
  },
  onPlant(site) {
    revealSpike();
    hud.banner('SPIKE PLANTED', `Defend site ${site} until it blows`, 3000);
    hud.killfeed(`Spike planted at ${site} (+$300)`, true);
    scoreboard.recordPlant('YOU');
    audio.plantStart();
    bots.hearShot(plantedPos(), 60);
  },
  onDetonate() {
    effects.explosion(plantedPos());
    audio.explosion();
    concealSpike();
  },
});

// ---- The bots and what they tell the rest of the game ----
const bots = createBots(scene, world, effects, audio, {
  playerPos: () => player.state.position,
  playerAlive: () => match.playerAlive,
  playerCrouching: () => player.state.crouching,
  playerSpeed: () => player.groundSpeed(),
  spikePlanted: () => Boolean(rounds.state.planted),
  spikeSite: () => (rounds.state.planted ? rounds.state.planted.site : null),
  spikePos: plantedPos,
  damagePlayer(amount, bot) {
    if (!match.playerAlive || match.frozen) return;
    match.health -= amount;
    match.lastDamageAt = match.elapsed;
    hud.damageFlash();
    hud.setHealth(match.health);
    damageFx.direction(bot.pos, player.state.position, player.state.yaw);
    if (match.health <= 0) killPlayer(bot);
  },
  onBotShot(bot) {
    minimap.pingEnemy(bot.id, bot.pos.x, bot.pos.z, match.elapsed);
  },
  onBotDamage(bot, amount) {
    scoreboard.recordDamage(bot, amount);
  },
  throwBotGrenade(bot, target) {
    const from = new THREE.Vector3(bot.pos.x, 1.4, bot.pos.z);
    const to = target.clone();
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const speed = Math.min(16, 9 + distance * 0.35);
    const arc = new THREE.Vector3(to.x - from.x, 0, to.z - from.z).normalize();
    arc.y = 0.55;
    grenades.throwFrom(from, arc, speed, true);
    hud.killfeed(`${bot.name} threw a frag`, false);
  },
  callout(bot, spotted) {
    hud.killfeed(`${bot.name} spotted ${spotted}`, false);
  },
  onBotDown(bot, attacker) {
    const killer = attacker && attacker.kind === 'player' ? YOU : attacker;
    const firstBlood = scoreboard.recordKill(killer, bot);
    hud.killfeed(`${killer ? killer.name : 'EMBER'} ▸ ${bot.name}`, killer === YOU);
    if (killer === YOU) {
      match.kills += 1;
      match.streak += 1;
      rounds.addKillReward();
      audio.kill();
      if (firstBlood) {
        rounds.state.money += FIRST_BLOOD;
        hud.banner('FIRST BLOOD', `+$${FIRST_BLOOD}`, 1600);
      } else if (match.streak >= 2) {
        const bonus = STREAK_BONUS[Math.min(match.streak, STREAK_BONUS.length - 1)];
        rounds.state.money += bonus;
        hud.banner(`KILL STREAK ×${match.streak}`, `+$${bonus}`, 1600);
      }
    }
  },
  onDefused(bot) {
    hud.banner('SPIKE DEFUSED', `${bot.name} cut the wires`, 3000);
    scoreboard.recordDefuse(bot.name);
    rounds.endRound('defend', 'Spike defused');
  },
});

// ---- Grenades: a blast hurts bots and the player with falloff ----
const grenades = createGrenades(scene, world.colliders, effects, audio, (pos, radius, damage) => {
  for (const bot of bots.bots) {
    if (!bot.alive) continue;
    const d = bot.pos.distanceTo(pos);
    if (d < radius) {
      const dealt = Math.round(damage * (1 - d / radius) + 10);
      bots.damageBot(bot, dealt, { kind: 'player' }, rng);
      scoreboard.recordDamage(YOU, dealt);
    }
  }
  if (match.playerAlive) {
    const p = player.state.position;
    const d = Math.hypot(p.x - pos.x, p.z - pos.z);
    if (d < radius) {
      match.health -= Math.round(damage * (1 - d / radius) * 0.7 + 8);
      match.lastDamageAt = match.elapsed;
      hud.damageFlash();
      hud.setHealth(match.health);
      if (match.health <= 0) {
        match.health = 0;
        killPlayer(null);
      }
    }
  }
});

// ---- Dying, respawning, restarting ----
function killPlayer(killerBot) {
  match.health = 0;
  match.playerAlive = false;
  match.streak = 0;
  scoreboard.recordKill(killerBot, YOU);
  match.spectateIndex = 0;
  hud.setHint('You are down — click to cycle your squad.');
  hud.showSpectate(spectateMate()?.name || '—');
  hud.banner('YOU ARE DOWN', 'Spectating — click to cycle teammates', 2200);
}

function spectateMate() {
  const mates = bots.bots.filter((b) => b.alive && b.team === 'attack');
  if (!mates.length) return null;
  return mates[match.spectateIndex % mates.length];
}

function respawnEveryone() {
  const spawns = world.spawns.attack;
  const spawn = spawns[Math.floor(rng() * spawns.length)];
  player.teleport(spawn.x, spawn.z, 0);
  match.health = 100;
  match.playerAlive = true;
  match.streak = 0;
  match.clutchCalled = false;
  match.plantProgress = 0;
  match.plantSite = null;
  match.lastDamageAt = -99;
  match.spectateIndex = 0;
  weapon.refill();
  grenades.reset();
  bots.spawnRound(rng, rounds.state.round);
  scoreboard.resetRound();
  hud.setHealth(100);
  hud.setScore(rounds.state.wins.attack, rounds.state.wins.defend);
  hud.setMoney(rounds.state.money);
  hud.setHint('');
  hud.plantProgress(null);
  hud.hideSpectate();
}

function restartMatch() {
  weapon.resetEconomy();
  scoreboard.resetMatch();
  scoreboard.register('YOU', 'attack');
  for (const bot of bots.bots) scoreboard.register(bot.name, bot.team);
  hud.setRoundPips([]);
  rounds.startMatch();
  hud.setScore(0, 0);
}

function onPointerLock(locked) {
  if (shotName) return;
  if (locked) {
    audio.unlock();
    hud.hideOverlay();
    if (match.buyOpen) closeBuy();
  } else if (!match.suppressPause && rounds.state.phase !== 'match') {
    hud.showOverlay(match.playerAlive ? 'paused' : 'paused', '');
    if (match.buyOpen) closeBuy();
  }
}

hud.onPlay(() => {
  if (shotName) return;
  if (rounds.state.phase === 'match') restartMatch();
  audio.unlock();
  input.requestLock();
});

// ---- The buy menu ----
function openBuy() {
  if (rounds.state.phase !== 'buy' || match.buyOpen) return;
  match.buyOpen = true;
  match.suppressPause = true;
  hud.showBuy(rounds.state.money, weapon.owned, weapon.state.grenades, rounds.state.round);
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeBuy() {
  if (!match.buyOpen) return;
  match.buyOpen = false;
  match.suppressPause = false;
  hud.hideBuy();
  if (!shotName) input.requestLock();
}

hud.onBuy((id) => {
  if (rounds.state.phase !== 'buy') return;
  let cost = null;
  if (id === 'grenade') cost = weapon.buyGrenade(rounds.state.money);
  else cost = weapon.buy(id, rounds.state.money);
  if (cost != null) {
    rounds.spend(cost);
    hud.setMoney(rounds.state.money);
    hud.refreshBuy(rounds.state.money, weapon.owned, weapon.state.grenades);
    if (id !== 'grenade') weapon.select(id);
    syncAmmoHud();
  }
});

function syncAmmoHud() {
  const def = weapon.currentDef();
  const slot = weapon.ammo[weapon.state.current];
  hud.setAmmo(slot.mag, slot.reserve, weapon.state.grenadeMode ? 'SPARK FRAG' : def.name, weapon.state.grenades);
}

// ---- Camera: first person alive, over-the-shoulder of a teammate when dead ----
function syncCamera() {
  if (!match.playerAlive) {
    const mate = spectateMate();
    if (mate) {
      camera.position.set(mate.pos.x, 1.6, mate.pos.z);
      camera.rotation.set(0, mate.yaw, 0, 'YXZ');
      return;
    }
  }
  const drop = match.playerAlive ? 0 : 1.1;
  const bob = player.bobOffset();
  camera.position.set(body.position.x, body.position.y + body.eye - drop + bob.y, body.position.z);
  camera.rotation.set(body.pitch + (match.playerAlive ? 0 : 0.35), body.yaw, match.playerAlive ? bob.x * 0.4 : 0.25, 'YXZ');
  const wantedFov = weapon.zoomFov();
  if (Math.abs(camera.fov - wantedFov) > 0.2) {
    camera.fov += (wantedFov - camera.fov) * 0.25;
    camera.updateProjectionMatrix();
  }
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function muzzleWorld() {
  camera.getWorldPosition(muzzlePos);
  camera.getWorldDirection(aimDir);
  muzzlePos.addScaledVector(aimDir, 0.55);
  muzzlePos.y -= 0.12;
  return muzzlePos;
}

function shootableTargets() {
  return world.shootables.concat(bots.hitMeshes);
}

// ---- Firing one trigger pull: pellets, spread, tracers, damage, brass ----
function shoot() {
  const def = weapon.currentDef();
  if (!weapon.takeRound()) {
    audio.dry();
    return;
  }
  const spread = weapon.spread(player.groundSpeed()) * (input.state.aiming && !weapon.state.zoomed ? 0.7 : 1);
  const pellets = def.pellets || 1;
  let killed = false;
  let hitAny = false;
  for (let p = 0; p < pellets; p += 1) {
    camera.getWorldDirection(aimDir);
    aimDir.x += (rng() * 2 - 1) * spread;
    aimDir.y += (rng() * 2 - 1) * spread;
    aimDir.z += (rng() * 2 - 1) * spread;
    aimDir.normalize();
    scene.updateMatrixWorld(true);
    raycaster.set(camera.position, aimDir);
    const from = muzzleWorld().clone();
    const hit = raycaster.intersectObjects(shootableTargets(), false)[0];
    const end = hit ? hit.point : camera.position.clone().addScaledVector(aimDir, 60);
    effects.tracer(from, end);
    if (hit) {
      const bot = hit.object.userData.bot;
      if (bot && bot.alive) {
        const headshot = hit.object.userData.part === 'head';
        const dmg = Math.round(def.damage * (headshot ? def.headMult : 1));
        bots.damageBot(bot, dmg, { kind: 'player' }, rng);
        scoreboard.recordDamage(YOU, dmg);
        hitAny = true;
        if (bot.health <= 0) killed = true;
        damageFx.spawn(camera, hit.point, dmg, headshot);
        if (bot.health > 0) audio.hit();
        effects.burst(hit.point, 0xff5a3c, 2.4);
      } else {
        effects.burst(hit.point, 0xffd9a0, 1.6);
      }
    }
  }
  if (hitAny) hud.hitMarker(killed, killed ? 4000 : 90);
  weapon.pullTrigger();
  // Brass pops out to the right; the big guns leave a wisp of smoke.
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  effects.eject(muzzleWorld().clone(), right);
  if (def.id === 'shotgun' || def.id === 'dmr') {
    effects.puff(muzzleWorld().clone(), 0.5, 0.6);
  }
  player.recoil(def.recoil * (0.9 + rng() * 0.25), (rng() * 2 - 1) * def.recoil * 0.3);
  bots.hearShot(player.state.position, 30);
  syncAmmoHud();
}

function throwGrenade() {
  if (!weapon.throwGrenade()) return;
  camera.getWorldDirection(aimDir);
  grenades.throwFrom(
    new THREE.Vector3(body.position.x, body.position.y + body.eye - 0.1, body.position.z),
    aimDir.clone(),
    13,
  );
  syncAmmoHud();
}

function siteUnderPlayer() {
  for (const site of ['A', 'B']) {
    const center = world.sites[site].center;
    const d = Math.hypot(body.position.x - center.x, body.position.z - center.z);
    if (d < world.sites[site].radius) return site;
  }
  return null;
}

function paintMinimap() {
  minimap.draw({
    player: { x: body.position.x, z: body.position.z, yaw: body.yaw },
    mates: bots.bots.filter((b) => b.alive && b.team === 'attack').map((b) => ({ x: b.pos.x, z: b.pos.z })),
    spike: rounds.state.planted ? { x: rounds.state.planted.pos.x, z: rounds.state.planted.pos.z } : null,
  }, match.elapsed);
}

// ---- One fixed simulation step ----
function step(dt) {
  match.elapsed += dt;
  const pressed = input.takePressed();
  const phase = rounds.state.phase;

  if (pressed.has('KeyB')) {
    if (match.buyOpen) closeBuy();
    else openBuy();
  }
  if (pressed.has('KeyF')) weapon.inspect();
  // Holding Tab shows the scoreboard; releasing it hides it. The match
  // summary is separate and stays up on its own.
  const tabHeld = input.state.keys.has('Tab');
  if (tabHeld && !match.tabWasHeld && rounds.state.phase !== 'match') {
    hud.showScoreboard(scoreboard.table(), `ROUND ${rounds.state.round} — SCOREBOARD`);
  } else if (!tabHeld && match.tabWasHeld && rounds.state.phase !== 'match') {
    hud.hideScoreboard();
  }
  match.tabWasHeld = tabHeld;

  if (match.buyOpen) {
    // Digit keys buy straight from the menu.
    const digitMap = { Digit1: 'pistol', Digit2: 'smg', Digit3: 'rifle', Digit4: 'shotgun', Digit5: 'dmr' };
    for (const [code, id] of Object.entries(digitMap)) {
      if (!pressed.has(code)) continue;
      if (rounds.state.phase !== 'buy') continue;
      const cost = weapon.buy(id, rounds.state.money);
      if (cost != null) {
        rounds.spend(cost);
        hud.setMoney(rounds.state.money);
        hud.refreshBuy(rounds.state.money, weapon.owned, weapon.state.grenades);
        weapon.select(id);
        syncAmmoHud();
      }
    }
    if (pressed.has('KeyG')) {
      const cost = weapon.buyGrenade(rounds.state.money);
      if (cost != null) {
        rounds.spend(cost);
        hud.setMoney(rounds.state.money);
        hud.refreshBuy(rounds.state.money, weapon.owned, weapon.state.grenades);
        syncAmmoHud();
      }
    }
  } else {
    for (const id of WEAPON_ORDER) {
      if (pressed.has(`Digit${WEAPONS[id].slot}`)) {
        if (weapon.select(id)) syncAmmoHud();
      }
    }
    if (pressed.has('KeyG')) {
      if (weapon.select('grenade')) syncAmmoHud();
    }
  }

  rounds.step(dt);
  if (phase === 'buy') {
    // Buy phase: the player can walk the spawn, the bots hold.
    player.step(dt, input.state.keys);
    weapon.step(dt, input.state.aiming, player.groundSpeed());
    effects.step(dt);
  } else if (phase === 'live') {
    player.step(dt, input.state.keys);
    weapon.step(dt, input.state.aiming, player.groundSpeed());
    bots.step(dt, match.elapsed, rng);
    grenades.step(dt);
    effects.step(dt);

    // Regen: six seconds without damage starts a slow heal.
    if (match.playerAlive && match.health > 0 && match.health < 100 && match.elapsed - match.lastDamageAt > REGEN_WAIT) {
      match.health = Math.min(100, match.health + REGEN_SPEED * dt);
      hud.setHealth(match.health);
    }
    // A heartbeat under 30 health.
    if (match.playerAlive && match.health > 0 && match.health <= 30 && match.elapsed - match.lastHeartbeat > 0.85) {
      match.lastHeartbeat = match.elapsed;
      audio.heartbeat();
    }
    // A live grenade close by earns a warning in the hint line.
    const liveGrenade = grenades.nearestLive(body.position.x, body.position.z);
    match.grenadeNear = Boolean(liveGrenade && liveGrenade.dist < 8);

    // Firing, and cycling the spectator camera while dead.
    const def = weapon.currentDef();
    const rawFiring = input.state.firing && input.state.locked;
    const freshClick = rawFiring && !match.wasFiring;
    if (!match.playerAlive && freshClick) {
      match.spectateIndex += 1;
      const mate = spectateMate();
      if (mate) hud.showSpectate(mate.name);
    }
    const firing = rawFiring && match.playerAlive;
    if (weapon.state.grenadeMode) {
      if (freshClick) throwGrenade();
    } else if (firing && weapon.ready() && (def.auto || freshClick)) {
      shoot();
    }
    match.wasFiring = rawFiring;
    if (pressed.has('KeyR')) weapon.reload();

    // Footsteps.
    if (player.state.stepped > 2.2) {
      player.state.stepped = 0;
      if (player.groundSpeed() > 1) audio.footstep();
    }

    // Planting: hold E inside a site while the spike is not down yet.
    const site = siteUnderPlayer();
    if (match.playerAlive && site && !rounds.state.planted && input.state.keys.has('KeyE')) {
      match.plantSite = site;
      match.plantProgress += dt / PLANT_TIME;
      hud.plantProgress(match.plantProgress, `PLANTING SPIKE — SITE ${site}`);
      if (Math.floor(match.elapsed * 2) !== Math.floor((match.elapsed - dt) * 2)) audio.plantBeep();
      if (match.plantProgress >= 1) {
        const center = world.sites[site].center;
        rounds.plant(site, new THREE.Vector3(center.x, 0, center.z));
        match.plantProgress = 0;
        hud.plantProgress(null);
      }
    } else {
      if (match.plantProgress > 0) {
        match.plantProgress = Math.max(0, match.plantProgress - dt / 1.5);
        hud.plantProgress(match.plantProgress > 0 ? match.plantProgress : null);
      }
      if (match.grenadeNear) {
        hud.setHint('⚠ Grenade nearby — move!');
      } else if (site && match.playerAlive && !rounds.state.planted) {
        hud.setHint('Hold E to plant the spike');
      } else if (rounds.state.planted) {
        hud.setHint(`Spike live — defend site ${rounds.state.planted.site}`);
      } else {
        const slot = weapon.ammo[weapon.state.current];
        if (match.playerAlive && slot.mag === 0 && slot.reserve === 0 && weapon.owned.size > 1) {
          hud.setHint('Out of ammo — switch weapon (1–5)');
        } else {
          hud.setHint('');
        }
      }
    }

    // A defender channelling a defuse shows on the same progress bar.
    const defuse = bots.defuseProgress();
    if (defuse > 0) {
      hud.plantProgress(defuse, 'EMBER IS DEFUSING THE SPIKE');
    } else if (match.plantProgress <= 0) {
      hud.plantProgress(null);
    }

    // Clutch: the player alone against two or more defenders gets one callout.
    const counts = bots.aliveCounts();
    const attackAlive = counts.attack + (match.playerAlive ? 1 : 0);
    if (match.playerAlive && attackAlive === 1 && counts.defend >= 2 && !match.clutchCalled) {
      match.clutchCalled = true;
      hud.banner('CLUTCH', `1 vs ${counts.defend} — the yard is watching`, 2400);
      audio.roundStart();
    }

    // Round end by elimination. Planted spike keeps the round alive while the
    // attackers are all dead: the defenders still have to defuse in time.
    if (counts.defend === 0) {
      rounds.endRound('attack', rounds.state.planted ? 'Site cleared' : 'EMBER eliminated');
    } else if (attackAlive === 0 && !rounds.state.planted) {
      rounds.endRound('defend', 'VANGUARD eliminated');
    }

    // The planted spike blinks until it blows.
    if (rounds.state.planted) {
      spikeLight.intensity = 6 + Math.sin(match.elapsed * 9) * 5;
    }
  } else {
    // Round over or match over: the world settles, the bots idle.
    effects.step(dt);
    weapon.step(dt, false, 0);
  }

  // The living yard and the feedback layers run in every phase.
  ambient.step(dt);
  damageFx.step(dt);
  paintMinimap();

  // HUD numbers, every step.
  hud.setHealth(match.health);
  hud.setMoney(rounds.state.money);
  hud.setTimer(rounds.timerText(), Boolean(rounds.state.planted));
  hud.setScore(rounds.state.wins.attack, rounds.state.wins.defend);
  const alive = bots.aliveCounts();
  hud.setAlive(alive.attack + (match.playerAlive ? 1 : 0), alive.defend);
  const spreadPx = 4 + weapon.spread(player.groundSpeed()) * 900;
  hud.setCrosshair(spreadPx);
  syncAmmoHud();
}

// ---- The frame loop: fixed steps for simulation, render every frame ----
let accumulator = 0;
let lastTime = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!match.frozen) {
    const look = input.takeLook();
    if (match.playerAlive) player.look(look.x, look.y, 0.0022 * settings.sensitivity);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP && steps < 5) {
      step(STEP);
      accumulator -= STEP;
      steps += 1;
    }
    if (accumulator > STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(STEP);
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      match.frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

// ---- Deterministic captures: the same frame every time, for the dossier ----
function runShot(name) {
  hud.hideOverlay();
  hud.hideBanner();
  rounds.startMatch();
  if (name === 'start') {
    player.teleport(0, 15.5, 0);
    settle(10);
    aimAt(new THREE.Vector3(0, 1.6, -4));
    hud.showOverlay('start', '');
  } else if (name === 'play') {
    // Mid-fight down the open mid lane: the player at mid-south looking north
    // at an EMBER bot in the open, a VANGUARD mate to the right, the crane
    // and site A behind them.
    const placeBot = (bot, x, z, yaw) => {
      bot.pos.set(x, 0, z);
      bot.group.position.copy(bot.pos);
      bot.yaw = yaw;
      bot.group.rotation.set(0, yaw, 0);
    };
    player.teleport(0, 10, 0);
    settle(10);
    const enemy = bots.bots.find((b) => b.team === 'defend');
    placeBot(enemy, 0, 0, Math.PI);
    const mate = bots.bots.find((b) => b.team === 'attack');
    placeBot(mate, 4.5, 3, Math.PI * 0.75);
    rounds.state.phase = 'live';
    rounds.state.phaseTime = 87;
    weapon.owned.add('rifle');
    weapon.select('rifle');
    syncAmmoHud();
    settle(30);
    // Three aimed shots at the same bot, with a beat between each.
    for (let shot = 0; shot < 3; shot += 1) {
      aimAt(new THREE.Vector3(enemy.pos.x, 1.15, enemy.pos.z));
      shoot();
      settle(8);
    }
    settle(2);
  } else if (name === 'buy') {
    player.teleport(0, 15.5, 0);
    settle(10);
    aimAt(new THREE.Vector3(0, 1.6, -4));
    rounds.state.money = 4700;
    hud.setMoney(4700);
    hud.showBuy(4700, weapon.owned, weapon.state.grenades);
  } else if (name === 'end') {
    rounds.state.wins.attack = 4;
    rounds.state.wins.defend = 2;
    rounds.state.phase = 'over';
    rounds.state.lastReason = 'Spike detonated';
    player.teleport(-10.5, -5.5, 0);
    settle(10);
    const enemy = bots.bots.find((b) => b.team === 'defend');
    enemy.pos.set(-15, 0, -10);
    enemy.group.position.copy(enemy.pos);
    enemy.alive = false;
    enemy.fall = 1;
    enemy.group.rotation.x = -1.45;
    enemy.group.position.y = -0.12;
    aimAt(new THREE.Vector3(-15, 1.2, -11));
    hud.banner('VANGUARD WINS THE ROUND', 'Spike detonated', 60000);
    hud.setScore(4, 2);
  }
  hud.setAmmo(weapon.ammo[weapon.state.current].mag, weapon.ammo[weapon.state.current].reserve,
    weapon.currentDef().name, weapon.state.grenades);
  hud.setHealth(match.health);
  hud.setScore(rounds.state.wins.attack, rounds.state.wins.defend);
  hud.setTimer(rounds.timerText(), Boolean(rounds.state.planted));
  paintTwiceThenReady();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// A small debug handle for the console and for automated smoke tests.
window.__game = {
  game: match, rounds, bots, weapon, player,
  state() {
    return {
      phase: rounds.state.phase,
      round: rounds.state.round,
      wins: rounds.state.wins,
      money: rounds.state.money,
      health: match.health,
      playerAlive: match.playerAlive,
      kills: match.kills,
      alive: bots.aliveCounts(),
      planted: Boolean(rounds.state.planted),
      mvp: scoreboard.mvp(),
    };
  },
};

bots.createAll(rng);
scoreboard.register('YOU', 'attack');
for (const bot of bots.bots) scoreboard.register(bot.name, bot.team);
rounds.startMatch();
syncCamera();
if (shotName) runShot(shotName);
else requestAnimationFrame(frame);
