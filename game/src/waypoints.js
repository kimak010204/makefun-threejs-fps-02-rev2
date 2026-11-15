// The waypoint graph bots walk on. Nodes sit in open floor (never inside a
// box); edges are straight walks the map leaves clear. Routes are found with
// a small breadth-first search.
import * as THREE from 'three';

// id: [x, z]
const POINTS = [
  [-4, 15], [0, 15.5], [4, 15], // 0-2 attacker spawn
  [-8, 10], [0, 10], [8, 10], // 3-5 south
  [-16, 12], [-16, 5], [-16, -2], [-12, -5], // 6-9 A lane (9: gap approach)
  [16, 12], [16, 5], [16, -2], [12, -5], // 10-13 B lane
  [0, 2], [-6.5, -1], [6.5, -1], [-8.5, -9], [8.5, -9], // 14-18 mid
  [-13.5, -9], [-14, -10.5], [-16.5, -10], [-13.5, -13.8], // 19-22 site A
  [13.5, -9], [15, -11], [16.5, -10], [13.5, -13.8], // 23-26 site B
  [-7, -15.5], [0, -16.5], [7, -15.5], // 27-29 defender spawn
  [-12, -11.5], [12, -11.5], // 30-31 site-side hold spots
  [-9, -11.5], [9, -11.5], // 32-33 north gaps
  [-12, -8.5], [12, -8.5], // 34-35 site entries
  [-9, -14.5], [9, -14.5], // 36-37 north strip
];

const LINKS = [
  [0, 3], [0, 4], [1, 4], [2, 4], [2, 5], [3, 4], [4, 5], [3, 6], [5, 10],
  [4, 14],
  [6, 7], [7, 8], [8, 9], [9, 34], [34, 19], [34, 20], [19, 20], [19, 22], [20, 21], [20, 22],
  [10, 11], [11, 12], [12, 13], [13, 35], [35, 23], [35, 24], [23, 24], [23, 26], [24, 25], [24, 26],
  [14, 15], [14, 16], [15, 17], [16, 18], [17, 18],
  [15, 8], [16, 12],
  [27, 28], [28, 29], [27, 36], [36, 32], [29, 37], [37, 33], [30, 22],
  [31, 25], [32, 17], [33, 18],
];

const neighbours = POINTS.map(() => []);
for (const [a, b] of LINKS) {
  neighbours[a].push(b);
  neighbours[b].push(a);
}

export const WAYPOINTS = POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z));

export function nearestNode(x, z) {
  let closest = 0;
  let closestDist = Infinity;
  for (let i = 0; i < POINTS.length; i += 1) {
    const dx = POINTS[i][0] - x;
    const dz = POINTS[i][1] - z;
    const distSq = dx * dx + dz * dz;
    if (distSq < closestDist) {
      closestDist = distSq;
      closest = i;
    }
  }
  return closest;
}

// Breadth-first route of node ids from `from` to `to`, both ends included.
export function route(from, to) {
  if (from === to) return [from];
  const cameFrom = new Array(POINTS.length).fill(-1);
  cameFrom[from] = from;
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    for (const next of neighbours[current]) {
      if (cameFrom[next] !== -1) continue;
      cameFrom[next] = current;
      if (next === to) {
        const path = [to];
        let node = to;
        while (node !== from) {
          node = cameFrom[node];
          path.unshift(node);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return [from, to];
}

export const SITE_NODES = { A: [20, 21, 22, 19], B: [24, 25, 26, 23] };
export const SPAWN_NODES = { attack: [0, 1, 2], defend: [27, 28, 29] };
