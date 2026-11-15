// Combat feedback you can feel: floating damage numbers that rise off a hit
// and a red arc at the screen edge that points at whoever just shot you. Both
// are pooled DOM, never allocated in the hot path, and both fade on their own.
import * as THREE from 'three';

const NUMBER_POOL = 10;
const NUMBER_LIFE = 0.75;

export function createDamageFx(container, arcEl) {
  const numbers = [];
  for (let i = 0; i < NUMBER_POOL; i += 1) {
    const el = document.createElement('div');
    el.className = 'dmg-num';
    el.style.display = 'none';
    container.appendChild(el);
    numbers.push({ el, life: 0, x: 0, y: 0 });
  }
  let numberCursor = 0;
  const projected = new THREE.Vector3();
  let arcTimer = 0;

  return {
    // Float a damage number at a world point, projected through the camera.
    spawn(camera, point, amount, headshot) {
      projected.copy(point).project(camera);
      if (projected.z > 1) return;
      const slot = numbers[numberCursor];
      numberCursor = (numberCursor + 1) % NUMBER_POOL;
      slot.x = (projected.x * 0.5 + 0.5) * window.innerWidth;
      slot.y = (-projected.y * 0.5 + 0.5) * window.innerHeight;
      slot.life = NUMBER_LIFE;
      slot.el.textContent = String(amount);
      slot.el.classList.toggle('head', Boolean(headshot));
      slot.el.style.display = 'block';
    },
    // Point the red arc at the shooter's bearing, relative to the player's view.
    direction(fromPos, playerPos, playerYaw) {
      const dx = fromPos.x - playerPos.x;
      const dz = fromPos.z - playerPos.z;
      const worldAngle = Math.atan2(dx, dz);
      const relative = worldAngle + playerYaw;
      const degrees = (relative * 180) / Math.PI;
      arcEl.style.setProperty('--arc-rot', `${degrees}deg`);
      arcEl.classList.add('on');
      clearTimeout(arcTimer);
      arcTimer = setTimeout(() => arcEl.classList.remove('on'), 700);
    },
    step(dt) {
      for (const slot of numbers) {
        if (slot.life <= 0) continue;
        slot.life -= dt;
        if (slot.life <= 0) {
          slot.el.style.display = 'none';
          continue;
        }
        const age = 1 - slot.life / NUMBER_LIFE;
        slot.el.style.left = `${slot.x}px`;
        slot.el.style.top = `${slot.y - age * 46}px`;
        slot.el.style.opacity = String(1 - age);
      }
    },
  };
}
