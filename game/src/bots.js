// The seven bots: three VANGUARD teammates at the player's side, four EMBER
// defenders holding the yard. This pass keeps the rev-2 squad plan —
// attackers split by lane (one to A, one to B, one through mid with the
// player), defenders hold a site each and rotate the instant the spike goes
// down — and adds four behaviours that make fights read better:
//
//   - Flanking: when the attackers pile onto one site, the defender furthest
//     from that site stops holding and rotates through mid to hit the push
//     from behind instead of walking into it head-on.
//   - Flinch: a bot the player just hit shoots wide for a moment, so landing
//     the first shot matters and duels are not decided by a coin flip.
//   - Retreat and callout: a hurt bot falls back toward its own site and its
//     nearest teammate converges on the threat, instead of wandering off.
//   - Push frags: a defender who hears the player close by lobs its frag at
//     the sound, not only at a planted spike.
//
// Fights still run on the same rules as the player's: line of sight, bursts
// with spread, and a reaction delay, so holding an angle and aiming beats
// spraying — for the bots and for the player alike.
//
// Two interface fixes from rev-1/rev-2 live here as well: the damage hook
// now receives the bot itself (so the direction indicator and the kill
// credit in main.js get a real name instead of a position vector), and the
// down hook passes the attacker through (so a player kill actually pays
// the kill reward instead of vanishing into a boolean).
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { WAYPOINTS, nearestNode, route, SITE_NODES, SPAWN_NODES } from './waypoints.js';

const BOT_RADIUS = 0.34;
const BOT_HEIGHT = 1.72;
const PATROL_SPEED = 3.7;
const PUSH_SPEED = 4.7;
const SEE_DISTANCE = 42;
const DEFUSE_TIME = 5;
const FRAGS_PER_ROUND = 1;
const FLINCH_WINDOW = 1.5; // seconds a recent hit keeps a bot inaccurate
const FLINCH_SPREAD = 1.6; // spread multiplier while flinching

const CALLSIGNS = {
  attack: ['DUST', 'RIVET', 'BOLT'],
  defend: ['ASH', 'COAL', 'SLAG', 'CINDER'],
};
const MID_NODES = [14, 15, 16];

// A bot that reads as a person at a glance: shoulders, backpack, visor and
// boots, with the team colour glowing on the trim.
function buildBotMesh(team) {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({
    color: new THREE.Color(team === 'attack' ? '#3a4a5e' : '#5e3a2a'), roughness: 0.75, metalness: 0.1,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: new THREE.Color(team === 'attack' ? PALETTE.vanguard : PALETTE.ember),
    roughness: 0.4, metalness: 0.2, emissive: new THREE.Color(team === 'attack' ? PALETTE.vanguard : PALETTE.ember),
    emissiveIntensity: 0.35,
  });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#14161a'), roughness: 0.6, metalness: 0.3 });
  const pack = new THREE.MeshStandardMaterial({ color: new THREE.Color('#23262e'), roughness: 0.85, metalness: 0.1 });
  const add = (geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // Boots, legs, knee pads.
  add(new THREE.BoxGeometry(0.17, 0.1, 0.3), dark, -0.12, 0.05, 0.03);
  add(new THREE.BoxGeometry(0.17, 0.1, 0.3), dark, 0.12, 0.05, 0.03);
  add(new THREE.BoxGeometry(0.16, 0.68, 0.16), dark, -0.12, 0.44, 0);
  add(new THREE.BoxGeometry(0.16, 0.68, 0.16), dark, 0.12, 0.44, 0);
  add(new THREE.BoxGeometry(0.18, 0.12, 0.06), glow, -0.12, 0.55, 0.1);
  add(new THREE.BoxGeometry(0.18, 0.12, 0.06), glow, 0.12, 0.55, 0.1);
  // Torso, chest plate, shoulder pads.
  const torso = add(new THREE.BoxGeometry(0.54, 0.72, 0.3), suit, 0, 1.12, 0);
  torso.userData.part = 'torso';
  add(new THREE.BoxGeometry(0.4, 0.4, 0.05), pack, 0, 1.14, 0.17);
  add(new THREE.BoxGeometry(0.56, 0.1, 0.32), glow, 0, 1.42, 0);
  add(new THREE.BoxGeometry(0.16, 0.1, 0.34), suit, -0.32, 1.42, 0);
  add(new THREE.BoxGeometry(0.16, 0.1, 0.34), suit, 0.32, 1.42, 0);
  // Backpack with a bedroll on top.
  add(new THREE.BoxGeometry(0.4, 0.5, 0.16), pack, 0, 1.16, -0.22);
  add(new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), suit, 0, 1.48, -0.24).rotation.z = Math.PI / 2;
  // Head, visor, chin strap.
  const head = add(new THREE.SphereGeometry(0.16, 14, 10), suit, 0, 1.62, 0);
  head.userData.part = 'head';
  add(new THREE.BoxGeometry(0.3, 0.07, 0.05), glow, 0, 1.64, 0.14);
  add(new THREE.BoxGeometry(0.2, 0.05, 0.05), dark, 0, 1.52, 0.13);
  // Rifle held across the chest, and a glowing belt line.
  const gun = add(new THREE.BoxGeometry(0.07, 0.09, 0.62), dark, 0.2, 1.18, -0.28);
  gun.rotation.x = 0.06;
  add(new THREE.BoxGeometry(0.34, 0.06, 0.06), glow, 0, 1.52, 0);
  return { group, torso, head };
}

export function createBots(scene, world, effects, audio, hooks) {
  const raycaster = new THREE.Raycaster();
  raycaster.far = 60;
  const bots = [];
  const hitMeshes = [];
  let now = 0;
  let round = 1;

  function clearShot(from, to) {
    const dir = new THREE.Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.normalize();
    raycaster.set(from, dir);
    raycaster.far = dist;
    const hit = raycaster.intersectObjects(world.shootables, false)[0];
    return !hit || hit.distance > dist - 0.3;
  }

  function makeBot(team, index, random) {
    const { group, torso, head } = buildBotMesh(team);
    scene.add(group);
    const bot = {
      id: `${team}-${index}`,
      name: CALLSIGNS[team][index],
      team,
      group, torso, head,
      pos: new THREE.Vector3(),
      yaw: 0,
      health: 100,
      alive: true,
      fall: 0,
      state: 'patrol',
      lane: team === 'attack' ? ['A', 'B', 'mid'][index] : (index < 2 ? 'A' : 'B'),
      route: [],
      routeIndex: 0,
      holdUntil: 0,
      holdSince: 0,
      crouching: false,
      target: null,
      lastSeen: new THREE.Vector3(),
      lastSeenAt: -99,
      hearPos: null,
      reaction: 0,
      burstLeft: 0,
      shotTimer: 0,
      strafeDir: 1,
      strafeUntil: 0,
      skill: 0.55 + random() * 0.3,
      reactionBase: 0.5 + random() * 0.5,
      defuseProgress: 0,
      defuseRoute: null,
      defuseRouteIndex: 0,
      defuseTarget: null,
      flash: 0,
      stepPhase: random() * 6,
      prevX: 0,
      prevZ: 0,
      stepAcc: 0,
      grenades: FRAGS_PER_ROUND,
      grenadeAt: -99,
      calloutAt: -99,
      spottedPlayer: false,
      lastHurtAt: -99,
      flanking: false,
    };
    torso.userData.bot = bot;
    head.userData.bot = bot;
    hitMeshes.push(torso, head);
    bots.push(bot);
    return bot;
  }

  function spawnRound(random, roundNumber) {
    round = roundNumber || 1;
    for (const bot of bots) {
      const nodes = SPAWN_NODES[bot.team];
      const node = WAYPOINTS[nodes[bots.indexOf(bot) % nodes.length]];
      bot.pos.copy(node);
      bot.pos.y = 0;
      bot.yaw = bot.team === 'attack' ? Math.PI : 0;
      bot.health = 100;
      bot.alive = true;
      bot.fall = 0;
      bot.state = 'patrol';
      bot.route = [];
      bot.routeIndex = 0;
      bot.holdUntil = 0;
      bot.holdSince = 0;
      bot.crouching = false;
      bot.target = null;
      bot.hearPos = null;
      bot.defuseProgress = 0;
      bot.defuseRoute = null;
      bot.defuseRouteIndex = 0;
      bot.defuseTarget = null;
      bot.flash = 0;
      bot.prevX = bot.pos.x;
      bot.prevZ = bot.pos.z;
      bot.stepAcc = 0;
      bot.grenades = FRAGS_PER_ROUND;
      bot.grenadeAt = -99;
      bot.calloutAt = -99;
      bot.spottedPlayer = false;
      bot.lastHurtAt = -99;
      bot.flanking = false;
      bot.group.visible = true;
      bot.group.rotation.set(0, bot.yaw, 0);
      bot.group.position.copy(bot.pos);
      bot.torso.material.emissive?.setHex(0x000000);
      chooseDestination(bot, random);
    }
  }

  // Squad plan: attackers push their lane, defenders hold their site, and
  // once the spike is down everyone converges on that site. A defender whose
  // site is being pushed by two or more attackers flanks through mid instead
  // of feeding the push one at a time.
  function chooseDestination(bot, random) {
    let dest;
    if (hooks.spikePlanted()) {
      const site = hooks.spikeSite();
      const nodes = SITE_NODES[site];
      dest = nodes[Math.floor(random() * nodes.length)];
    } else if (bot.team === 'defend') {
      const nodes = SITE_NODES[bot.lane];
      dest = nodes[Math.floor(random() * nodes.length)];
    } else if (bot.lane === 'mid') {
      dest = MID_NODES[Math.floor(random() * MID_NODES.length)];
    } else {
      const nodes = SITE_NODES[bot.lane];
      dest = nodes[Math.floor(random() * nodes.length)];
    }
    bot.route = route(nearestNode(bot.pos.x, bot.pos.z), dest).map((i) => WAYPOINTS[i]);
    bot.routeIndex = 0;
    bot.state = 'patrol';
    bot.holdSince = now;
    bot.flanking = false;
  }

  function attackersOnSite(site) {
    const center = site === 'A' ? { x: -15, z: -11 } : { x: 15, z: -11 };
    let count = 0;
    if (hooks.playerAlive()) {
      const p = hooks.playerPos();
      if (Math.hypot(p.x - center.x, p.z - center.z) < 9) count += 1;
    }
    for (const other of bots) {
      if (!other.alive || other.team !== 'attack') continue;
      if (Math.hypot(other.pos.x - center.x, other.pos.z - center.z) < 9) count += 1;
    }
    return count;
  }

  function considerFlank(bot, random) {
    if (bot.team !== 'defend' || bot.state !== 'patrol' || bot.flanking) return;
    if (hooks.spikePlanted()) return;
    const pushedSite = attackersOnSite('A') >= 2 ? 'A' : attackersOnSite('B') >= 2 ? 'B' : null;
    if (!pushedSite) return;
    // Only the defender furthest from the pushed site flanks; the rest hold.
    const defenders = bots.filter((b) => b.alive && b.team === 'defend');
    const center = pushedSite === 'A' ? { x: -15, z: -11 } : { x: 15, z: -11 };
    const furthest = defenders.sort((a, b) =>
      Math.hypot(center.x - b.pos.x, center.z - b.pos.z) - Math.hypot(center.x - a.pos.x, center.z - a.pos.z))[0];
    if (furthest !== bot) return;
    const mid = MID_NODES[Math.floor(random() * MID_NODES.length)];
    const siteNodes = SITE_NODES[pushedSite];
    const end = siteNodes[Math.floor(random() * siteNodes.length)];
    const legOne = route(nearestNode(bot.pos.x, bot.pos.z), mid).map((i) => WAYPOINTS[i]);
    const legTwo = route(mid, end).map((i) => WAYPOINTS[i]);
    bot.route = legOne.concat(legTwo);
    bot.routeIndex = 0;
    bot.state = 'patrol';
    bot.flanking = true;
    bot.holdSince = now;
  }

  const probe = new THREE.Box3();
  function isBlocked(x, z) {
    probe.min.set(x - BOT_RADIUS, 0.04, z - BOT_RADIUS);
    probe.max.set(x + BOT_RADIUS, BOT_HEIGHT - 0.04, z + BOT_RADIUS);
    for (const collider of world.colliders) if (probe.intersectsBox(collider)) return true;
    return false;
  }

  function walkToward(bot, target, dt, speed) {
    const dx = target.x - bot.pos.x;
    const dz = target.z - bot.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return true;
    const stepLen = Math.min(dist, speed * dt);
    const nx = bot.pos.x + (dx / dist) * stepLen;
    const nz = bot.pos.z + (dz / dist) * stepLen;
    if (!isBlocked(nx, bot.pos.z)) bot.pos.x = nx;
    if (!isBlocked(bot.pos.x, nz)) bot.pos.z = nz;
    bot.yaw = Math.atan2(dx, dz) + Math.PI;
    return dist < 0.7;
  }

  function eyeOf(bot) {
    return new THREE.Vector3(bot.pos.x, bot.crouching ? 1.05 : 1.5, bot.pos.z);
  }

  function playerAimPoint() {
    const p = hooks.playerPos();
    return new THREE.Vector3(p.x, p.y + 1.15, p.z);
  }

  function botAimPoint(other) {
    return new THREE.Vector3(other.pos.x, other.crouching ? 0.85 : 1.15, other.pos.z);
  }

  // Can this bot see that point? Range, facing, and a clear line. A crouched
  // target is harder to spot; a crouched watcher shoots steadier.
  function seesPoint(bot, point, rangeScale = 1) {
    const eye = eyeOf(bot);
    const to = new THREE.Vector3().subVectors(point, eye);
    const dist = to.length();
    if (dist > SEE_DISTANCE * rangeScale) return false;
    if (dist > 6) {
      to.normalize();
      const facing = new THREE.Vector3(Math.sin(bot.yaw + Math.PI), 0, Math.cos(bot.yaw + Math.PI));
      if (facing.dot(to) < 0.15) return false;
    }
    return clearShot(eye, point);
  }

  function pickTarget(bot) {
    let best = null;
    let bestDist = Infinity;
    if (bot.team === 'defend' && hooks.playerAlive()) {
      const point = playerAimPoint();
      const scale = hooks.playerCrouching() && hooks.playerSpeed() < 0.5 ? 0.55 : 1;
      if (seesPoint(bot, point, scale)) {
        best = { kind: 'player', pos: point };
        bestDist = eyeOf(bot).distanceTo(point);
        if (!bot.spottedPlayer && now - bot.calloutAt > 8) {
          bot.spottedPlayer = true;
          bot.calloutAt = now;
          hooks.callout?.(bot, 'YOU');
        }
      }
    }
    for (const other of bots) {
      if (!other.alive || other.team === bot.team) continue;
      const point = botAimPoint(other);
      const scale = other.crouching ? 0.75 : 1;
      if (!seesPoint(bot, point, scale)) continue;
      const dist = eyeOf(bot).distanceTo(point);
      if (dist < bestDist) {
        bestDist = dist;
        best = { kind: 'bot', ref: other, pos: point };
      }
    }
    return best;
  }

  const ray = new THREE.Ray();
  const playerBox = new THREE.Box3();
  const playerHead = new THREE.Sphere();
  function fireAt(bot, target, dt, random) {
    // One hitscan round at the target. Spread comes from skill, distance and
    // motion; a bot the player just hit flinches and shoots wider, and the
    // squad's skill creeps up a touch every round. Crouching tightens a bot.
    const muzzle = eyeOf(bot);
    muzzle.y -= 0.25;
    const aim = new THREE.Vector3().subVectors(target.pos, muzzle).normalize();
    const dist = eyeOf(bot).distanceTo(target.pos);
    const moving = target.kind === 'player' ? hooks.playerSpeed() : 3;
    const roundBonus = Math.min(0.1, (round - 1) * 0.02);
    const skill = Math.min(0.95, bot.skill + roundBonus);
    const flinch = now - bot.lastHurtAt < FLINCH_WINDOW ? FLINCH_SPREAD : 1;
    const spread = (0.012 + dist * 0.0009 + moving * 0.004) * (1.25 - skill * 0.5)
      * (bot.crouching ? 0.8 : 1) * flinch;
    aim.x += (random() * 2 - 1) * spread;
    aim.y += (random() * 2 - 1) * spread;
    aim.z += (random() * 2 - 1) * spread;
    aim.normalize();
    ray.set(muzzle, aim);
    let hitPoint = null;
    let hitBot = null;
    let hitPlayer = false;
    let headshot = false;
    if (target.kind === 'player') {
      const p = hooks.playerPos();
      playerBox.min.set(p.x - 0.34, p.y, p.z - 0.34);
      playerBox.max.set(p.x + 0.34, p.y + 1.72, p.z + 0.34);
      playerHead.center.set(p.x, p.y + 1.52, p.z);
      playerHead.radius = 0.17;
      const headHit = ray.intersectsSphere(playerHead);
      const bodyHit = ray.intersectsBox(playerBox);
      if (headHit || bodyHit) {
        headshot = headHit;
        hitPlayer = true;
        const t = ray.distanceToPoint(playerHead.center);
        hitPoint = muzzle.clone().addScaledVector(aim, Math.max(1, t));
      }
    } else {
      raycaster.set(muzzle, aim);
      raycaster.far = 60;
      const hit = raycaster.intersectObjects([target.ref.torso, target.ref.head], false)[0];
      if (hit) {
        hitBot = target.ref;
        headshot = hit.object.userData.part === 'head';
        hitPoint = hit.point;
      }
    }
    if (!hitPoint) {
      raycaster.set(muzzle, aim);
      raycaster.far = 60;
      const wall = raycaster.intersectObjects(world.shootables, false)[0];
      hitPoint = wall ? wall.point : muzzle.clone().addScaledVector(aim, 40);
      if (wall) effects.burst(wall.point, 0xffd9a0, 2);
    }
    effects.tracer(muzzle, hitPoint);
    hooks.onBotShot?.(bot);
    const distToPlayer = hooks.playerPos().distanceTo(muzzle);
    if (distToPlayer < 34) audio.enemyShot(distToPlayer);
    if (hitPlayer) {
      const dmg = Math.round((headshot ? 26 : 11) * (0.85 + random() * 0.3));
      hooks.damagePlayer(dmg, bot);
    } else if (hitBot) {
      damageBot(hitBot, headshot ? 34 : 13, bot, random);
    }
  }

  function damageBot(bot, amount, attacker, random) {
    if (!bot.alive) return;
    bot.health -= amount;
    bot.flash = 0.12;
    if (attacker && attacker.kind === 'player') {
      bot.lastSeen.copy(hooks.playerPos());
      bot.lastSeenAt = now;
      bot.hearPos = hooks.playerPos().clone();
      bot.spottedPlayer = true;
      bot.lastHurtAt = now;
    }
    if (attacker && attacker.name) hooks.onBotDamage?.(attacker, amount);
    // Hurt bots give ground: under 30 health they fall back toward their own
    // site and their nearest teammate converges on the threat.
    if (bot.health > 0 && bot.health <= 30 && bot.state === 'engage') {
      bot.state = 'patrol';
      bot.target = null;
      const siteNodes = SITE_NODES[bot.lane === 'mid' ? (bot.team === 'attack' ? 'A' : bot.lane) : bot.lane];
      const dest = siteNodes[Math.floor(random() * siteNodes.length)];
      bot.route = route(nearestNode(bot.pos.x, bot.pos.z), dest).map((i) => WAYPOINTS[i]);
      bot.routeIndex = 0;
      bot.holdSince = now;
      const mate = bots
        .filter((b) => b.alive && b.team === bot.team && b !== bot)
        .sort((a, b) => a.pos.distanceToSquared(bot.pos) - b.pos.distanceToSquared(bot.pos))[0];
      if (mate) mate.hearPos = bot.lastSeen.clone();
      return;
    }
    if (bot.health > 0) return;
    bot.alive = false;
    bot.fall = 0;
    bot.defuseProgress = 0;
    hooks.onBotDown(bot, attacker);
  }

  // A frag on an arc at a point the squad wants cleared. Defenders clear the
  // planted spike; attackers clear a site they are about to push; and a
  // defender who hears the player close by lobs one at the sound.
  function maybeLobGrenade(bot, random) {
    if (bot.grenades <= 0 || now - bot.grenadeAt < 20) return;
    let aimPoint = null;
    if (hooks.spikePlanted() && bot.team === 'defend') {
      aimPoint = hooks.spikePos();
    } else if (bot.team === 'defend' && bot.hearPos) {
      const d = Math.hypot(bot.hearPos.x - bot.pos.x, bot.hearPos.z - bot.pos.z);
      if (d >= 5 && d <= 24 && random() < 0.35) aimPoint = bot.hearPos.clone();
    } else if (bot.team === 'attack' && bot.state === 'patrol' && bot.route.length) {
      const end = bot.route[bot.route.length - 1];
      if (Math.hypot(end.x - bot.pos.x, end.z - bot.pos.z) < 9 && random() < 0.02) {
        aimPoint = end.clone();
      }
    }
    if (!aimPoint) return;
    const dist = Math.hypot(aimPoint.x - bot.pos.x, aimPoint.z - bot.pos.z);
    if (dist < 4 || dist > 26) return;
    bot.grenades -= 1;
    bot.grenadeAt = now;
    hooks.throwBotGrenade?.(bot, aimPoint);
  }

  function updateBot(bot, dt, random) {
    if (!bot.alive) {
      if (bot.fall < 1) {
        bot.fall = Math.min(1, bot.fall + dt / 0.45);
        bot.group.rotation.x = -bot.fall * 1.45;
        bot.group.position.y = -bot.fall * 0.12;
      }
      return;
    }
    bot.flash = Math.max(0, bot.flash - dt);
    bot.torso.material.emissive.setHex(bot.flash > 0 ? 0x881111 : 0x000000);

    // Crouch-peek: a bot holding one spot for a while drops low to peek it.
    if (bot.state === 'patrol' && now - bot.holdSince > 4 && !bot.crouching) {
      bot.crouching = true;
    } else if (bot.state !== 'patrol' && bot.crouching) {
      bot.crouching = false;
    }

    // Defuse: the nearest living defender channels on the planted spike.
    if (hooks.spikePlanted() && bot.team === 'defend') {
      const spikePos = hooks.spikePos();
      const distToSpike = Math.hypot(spikePos.x - bot.pos.x, spikePos.z - bot.pos.z);
      const nearestDefender = bots
        .filter((b) => b.alive && b.team === 'defend')
        .sort((a, b) => Math.hypot(hooks.spikePos().x - a.pos.x, hooks.spikePos().z - a.pos.z)
          - Math.hypot(hooks.spikePos().x - b.pos.x, hooks.spikePos().z - b.pos.z))[0];
      if (nearestDefender === bot) {
        if (distToSpike > 1.4) {
          // Route through the waypoint graph: a straight walk gets stuck on
          // the site walls (a defender north of the site can never walk
          // through its north wall). The last leg closes on the spike itself.
          if (!bot.defuseRoute || bot.defuseRouteIndex >= bot.defuseRoute.length
            || !bot.defuseTarget || bot.defuseTarget.distanceToSquared(spikePos) > 0.25) {
            const dest = nearestNode(spikePos.x, spikePos.z);
            bot.defuseRoute = route(nearestNode(bot.pos.x, bot.pos.z), dest).map((i) => WAYPOINTS[i]);
            bot.defuseRoute.push(spikePos.clone());
            bot.defuseRouteIndex = 0;
            bot.defuseTarget = spikePos.clone();
          }
          const node = bot.defuseRoute[bot.defuseRouteIndex];
          if (walkToward(bot, node, dt, PUSH_SPEED)) bot.defuseRouteIndex += 1;
          bot.defuseProgress = 0;
        } else {
          bot.defuseProgress += dt / DEFUSE_TIME;
          bot.yaw = Math.atan2(spikePos.x - bot.pos.x, spikePos.z - bot.pos.z) + Math.PI;
          if (Math.floor(now * 2) !== Math.floor((now - dt) * 2)) audio.defuseBeep();
          if (bot.defuseProgress >= 1) hooks.onDefused(bot);
          return;
        }
      } else {
        maybeLobGrenade(bot, random);
      }
    }

    const target = pickTarget(bot);
    if (target) {
      bot.target = target;
      bot.lastSeen.copy(target.pos);
      bot.lastSeenAt = now;
      if (bot.state !== 'engage') {
        bot.state = 'engage';
        const roundBonus = Math.min(0.15, (round - 1) * 0.03);
        bot.reaction = Math.max(0.25, bot.reactionBase * (0.7 + random() * 0.6) - roundBonus);
        bot.burstLeft = 0;
        bot.shotTimer = 0;
      }
    } else if (bot.state === 'engage') {
      if (now - bot.lastSeenAt > 1.6) {
        bot.state = 'patrol';
        bot.target = null;
        bot.spottedPlayer = false;
        if (bot.hearPos) {
          bot.route = [bot.hearPos.clone()];
          bot.routeIndex = 0;
          bot.hearPos = null;
        } else {
          chooseDestination(bot, random);
        }
      } else {
        // Keep the last seen corner covered while the target is briefly hidden.
        bot.target = { kind: 'point', pos: bot.lastSeen };
      }
    }

    if (bot.state === 'engage' && bot.target) {
      const toTarget = new THREE.Vector3().subVectors(bot.target.pos, bot.pos);
      const dist = Math.hypot(toTarget.x, toTarget.z);
      bot.yaw = Math.atan2(toTarget.x, toTarget.z) + Math.PI;
      // Strafe sideways; close in when far, back off when too close.
      if (now > bot.strafeUntil) {
        bot.strafeDir = random() < 0.5 ? -1 : 1;
        bot.strafeUntil = now + 0.7 + random() * 0.9;
      }
      const side = new THREE.Vector3(-toTarget.z, 0, toTarget.x).normalize().multiplyScalar(bot.strafeDir);
      const toward = dist > 20 ? 1 : dist < 6 ? -1 : 0;
      const move = side.addScaledVector(toTarget.clone().normalize(), toward * 0.7).normalize();
      const stepVec = move.multiplyScalar(PATROL_SPEED * 0.75 * dt);
      if (!isBlocked(bot.pos.x + stepVec.x, bot.pos.z)) bot.pos.x += stepVec.x;
      if (!isBlocked(bot.pos.x, bot.pos.z + stepVec.z)) bot.pos.z += stepVec.z;
      if (bot.target.kind !== 'point') {
        if (bot.reaction > 0) {
          bot.reaction -= dt;
        } else {
          if (bot.burstLeft === 0) {
            bot.burstLeft = 3 + Math.floor(random() * 3);
            bot.shotTimer = 0;
          }
          bot.shotTimer -= dt;
          if (bot.shotTimer <= 0 && bot.burstLeft > 0) {
            fireAt(bot, bot.target, dt, random);
            bot.burstLeft -= 1;
            bot.shotTimer = bot.burstLeft > 0 ? 0.13 : 0.55 + random() * 0.5;
          }
        }
      }
    } else if (bot.state === 'patrol') {
      considerFlank(bot, random);
      maybeLobGrenade(bot, random);
      if (now < bot.holdUntil) {
        // Holding a position: scan slowly.
        bot.yaw += dt * 0.35;
      } else if (bot.route.length && bot.routeIndex < bot.route.length) {
        const node = bot.route[bot.routeIndex];
        if (walkToward(bot, node, dt, hooks.spikePlanted() ? PUSH_SPEED : PATROL_SPEED)) {
          bot.routeIndex += 1;
          if (bot.routeIndex >= bot.route.length) {
            bot.holdUntil = now + 2.5 + random() * 5;
            bot.holdSince = now;
            if (random() < 0.6) chooseDestination(bot, random);
          }
        }
      } else {
        chooseDestination(bot, random);
      }
    }

    // Footsteps: a moving bot is audible when it walks close to the player.
    const moved = Math.hypot(bot.pos.x - bot.prevX, bot.pos.z - bot.prevZ);
    bot.prevX = bot.pos.x;
    bot.prevZ = bot.pos.z;
    if (moved > 0.001) {
      bot.stepAcc += moved;
      if (bot.stepAcc > 2.2) {
        bot.stepAcc = 0;
        const distToPlayer = Math.hypot(hooks.playerPos().x - bot.pos.x, hooks.playerPos().z - bot.pos.z);
        if (distToPlayer < 18) audio.botStep(distToPlayer);
      }
    }

    bot.group.position.copy(bot.pos);
    bot.group.position.y = bot.crouching ? -0.35 : 0;
    bot.group.rotation.set(0, bot.yaw, 0);
  }

  function createAll(random) {
    for (let i = 0; i < 3; i += 1) makeBot('attack', i, random);
    for (let i = 0; i < 4; i += 1) makeBot('defend', i, random);
  }

  return {
    bots,
    hitMeshes,
    createAll,
    spawnRound,
    damageBot,
    step(dt, time, random) {
      now = time;
      for (const bot of bots) updateBot(bot, dt, random);
    },
    hearShot(fromPos, radius = 30) {
      for (const bot of bots) {
        if (!bot.alive) continue;
        if (bot.pos.distanceTo(fromPos) < radius) {
          bot.hearPos = fromPos.clone();
          if (bot.state === 'patrol' && bot.routeIndex >= bot.route.length - 1) {
            bot.route = [fromPos.clone()];
            bot.routeIndex = 0;
          }
        }
      }
    },
    aliveCounts() {
      return {
        attack: bots.filter((b) => b.alive && b.team === 'attack').length,
        defend: bots.filter((b) => b.alive && b.team === 'defend').length,
      };
    },
    defuseProgress() {
      const defuser = bots.find((b) => b.alive && b.team === 'defend' && b.defuseProgress > 0);
      return defuser ? defuser.defuseProgress : 0;
    },
    reset() {
      for (const bot of bots) {
        bot.group.visible = false;
        bot.alive = false;
      }
    },
  };
}
