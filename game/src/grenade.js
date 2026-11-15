// SPARK frag grenades: thrown on an arc, they bounce once or twice off the
// map, beep faster as the fuse runs down, then detonate. Damage falls off
// with distance, and the blast hurts the thrower too, so the arc matters. One
// mesh per live grenade, reused from a small pool. Bots throw them as well
// (their throws arc from the hand with a lob), and the game can ask for the
// nearest live grenade to warn the player.
import * as THREE from 'three';

const FALL = 14;
const MAX_LIVE = 4;
const BLAST_RADIUS = 6.5;
const BLAST_DAMAGE = 95;
const FUSE = 2.4;

export function createGrenades(scene, colliders, effects, audio, onExplode) {
  const pool = [];
  const shellMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3f6f4a'), roughness: 0.6, metalness: 0.3 });
  const ballGeo = new THREE.SphereGeometry(0.09, 12, 9);
  for (let i = 0; i < MAX_LIVE; i += 1) {
    const mesh = new THREE.Mesh(ballGeo, shellMat);
    mesh.visible = false;
    mesh.castShadow = true;
    scene.add(mesh);
    pool.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), fuse: 0, bounced: false, live: false, beepAt: 0 });
  }

  const probe = new THREE.Box3();
  function hitsSolid(x, y, z) {
    probe.min.set(x - 0.09, y - 0.09, z - 0.09);
    probe.max.set(x + 0.09, y + 0.09, z + 0.09);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  function detonate(slot) {
    slot.live = false;
    slot.mesh.visible = false;
    effects.explosion(slot.pos);
    effects.puff(slot.pos, 1.6, 1.1);
    audio.explosion();
    onExplode(slot.pos.clone(), BLAST_RADIUS, BLAST_DAMAGE);
  }

  return {
    throwFrom(from, dir, speed = 13, lob = false) {
      const slot = pool.find((s) => !s.live);
      if (!slot) return false;
      slot.live = true;
      slot.pos.copy(from);
      slot.vel.copy(dir).multiplyScalar(speed);
      slot.vel.y += lob ? 5.5 : 3.2;
      slot.fuse = FUSE;
      slot.bounced = false;
      slot.beepAt = 0;
      slot.mesh.visible = true;
      slot.mesh.position.copy(slot.pos);
      return true;
    },
    liveCount() {
      return pool.filter((s) => s.live).length;
    },
    nearestLive(x, z) {
      let best = null;
      let bestDist = Infinity;
      for (const slot of pool) {
        if (!slot.live) continue;
        const d = Math.hypot(slot.pos.x - x, slot.pos.z - z);
        if (d < bestDist) {
          bestDist = d;
          best = slot;
        }
      }
      return best ? { pos: best.pos, dist: bestDist, fuse: best.fuse } : null;
    },
    step(dt) {
      for (const slot of pool) {
        if (!slot.live) continue;
        slot.fuse -= dt;
        slot.vel.y -= FALL * dt;
        const next = slot.pos.clone().addScaledVector(slot.vel, dt);
        const wall = hitsSolid(next.x, next.y, next.z);
        if (wall) {
          // Cheap bounce: reverse the axis that moved into the box most.
          const mx = Math.abs(next.x - slot.pos.x);
          const mz = Math.abs(next.z - slot.pos.z);
          const my = Math.abs(next.y - slot.pos.y);
          if (my >= mx && my >= mz) slot.vel.y = -slot.vel.y * 0.45;
          else if (mx >= mz) slot.vel.x = -slot.vel.x * 0.45;
          else slot.vel.z = -slot.vel.z * 0.45;
          slot.vel.multiplyScalar(0.7);
          if (!slot.bounced) {
            slot.bounced = true;
            slot.fuse = Math.min(slot.fuse, 1.4);
          }
        } else {
          slot.pos.copy(next);
        }
        if (slot.pos.y < 0.09) {
          slot.pos.y = 0.09;
          slot.vel.y = Math.abs(slot.vel.y) * 0.45;
          slot.vel.x *= 0.7;
          slot.vel.z *= 0.7;
          if (!slot.bounced) {
            slot.bounced = true;
            slot.fuse = Math.min(slot.fuse, 1.4);
          }
        }
        slot.mesh.position.copy(slot.pos);
        // The beep quickens as the fuse runs down.
        if (slot.fuse < 1.2) {
          slot.beepAt -= dt;
          if (slot.beepAt <= 0) {
            slot.beepAt = slot.fuse < 0.6 ? 0.18 : 0.35;
            audio.grenadeBeep();
          }
        }
        if (slot.fuse <= 0) detonate(slot);
      }
    },
    reset() {
      for (const slot of pool) {
        slot.live = false;
        slot.mesh.visible = false;
      }
    },
  };
}
