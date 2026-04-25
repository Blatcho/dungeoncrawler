const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const roomLabel = document.getElementById('roomLabel');
const weaponLabel = document.getElementById('weaponLabel');

const TILE_W = 96;
const TILE_H = 48;
const GRID_W = 11;
const GRID_H = 11;
const PLAYER_SPEED = 4.1;

const keys = new Set();
const pointer = { x: canvas.width / 2, y: canvas.height / 2, down: false };

let lastTime = 0;
let shotCooldown = 0;
let punchCooldown = 0;
let cameraShake = 0;

const particles = [];
const projectiles = [];

const roomCache = new Map();
const roomHistory = [];

const audio = (() => {
  const api = {
    ctx: null,
    enabled: false,
    unlock() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.enabled = true;
    },
    beep({ freq = 440, duration = 0.08, type = 'square', gain = 0.03, slide = 0.8 }) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, now);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), now + duration);
      g.gain.setValueAtTime(gain, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      o.connect(g).connect(this.ctx.destination);
      o.start(now);
      o.stop(now + duration);
    },
    fire() {
      this.beep({ freq: 220, duration: 0.06, gain: 0.04, type: 'sawtooth', slide: 1.8 });
    },
    impact() {
      this.beep({ freq: 110, duration: 0.12, gain: 0.07, type: 'triangle', slide: 0.5 });
    },
    break() {
      this.beep({ freq: 80, duration: 0.2, gain: 0.08, type: 'square', slide: 0.35 });
    },
  };
  return api;
})();

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function worldToScreen(x, y, z = 0) {
  const originX = canvas.width / 2;
  const originY = canvas.height * 0.2;
  return {
    x: originX + (x - y) * (TILE_W / 2),
    y: originY + (x + y) * (TILE_H / 2) - z,
  };
}

function screenToWorld(sx, sy) {
  const originX = canvas.width / 2;
  const originY = canvas.height * 0.2;
  const x = ((sx - originX) / (TILE_W / 2) + (sy - originY) / (TILE_H / 2)) / 2;
  const y = ((sy - originY) / (TILE_H / 2) - (sx - originX) / (TILE_W / 2)) / 2;
  return { x, y };
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roomKey(rx, ry) {
  return `${rx},${ry}`;
}

function hashRoom(rx, ry) {
  return (rx * 73856093) ^ (ry * 19349663) ^ 0x9e3779b9;
}

function makeRoom(rx, ry) {
  const rng = mulberry32(hashRoom(rx, ry));
  const debris = [];
  for (let i = 0; i < 20; i++) {
    const x = 1 + Math.floor(rng() * (GRID_W - 2));
    const y = 1 + Math.floor(rng() * (GRID_H - 2));
    if ((x === 5 && y === 5) || (x <= 1 || y <= 1 || x >= GRID_W - 2 || y >= GRID_H - 2)) continue;
    const strengthTier = Math.floor(rng() * 3);
    debris.push({
      id: `d_${i}`,
      x,
      y,
      type: rng() > 0.5 ? 'pillar' : 'crate',
      hp: [40, 75, 120][strengthTier],
      maxHp: [40, 75, 120][strengthTier],
      armor: [0.4, 0.65, 0.9][strengthTier],
      height: 24 + rng() * 48,
    });
  }

  const walls = [];
  for (let x = 0; x < GRID_W; x++) {
    walls.push({ x, y: 0, hp: 180, maxHp: 180, armor: 0.85, vertical: false });
    walls.push({ x, y: GRID_H - 1, hp: 180, maxHp: 180, armor: 0.85, vertical: false });
  }
  for (let y = 1; y < GRID_H - 1; y++) {
    walls.push({ x: 0, y, hp: 180, maxHp: 180, armor: 0.85, vertical: true });
    walls.push({ x: GRID_W - 1, y, hp: 180, maxHp: 180, armor: 0.85, vertical: true });
  }

  const doors = [
    { dir: 'N', x: 5, y: 0, tx: 0, ty: -1 },
    { dir: 'S', x: 5, y: GRID_H - 1, tx: 0, ty: 1 },
    { dir: 'W', x: 0, y: 5, tx: -1, ty: 0 },
    { dir: 'E', x: GRID_W - 1, y: 5, tx: 1, ty: 0 },
  ];

  for (const d of doors) {
    const idx = walls.findIndex((w) => w.x === d.x && w.y === d.y);
    if (idx !== -1) walls.splice(idx, 1);
  }

  return { rx, ry, debris, walls, doors, embers: rng() * 100 };
}

function getRoom(rx, ry) {
  const key = roomKey(rx, ry);
  if (!roomCache.has(key)) {
    roomCache.set(key, makeRoom(rx, ry));
    roomHistory.push(key);
    if (roomHistory.length > 2) {
      const old = roomHistory.shift();
      if (old) roomCache.delete(old);
    }
  }
  return roomCache.get(key);
}

const player = {
  x: 5,
  y: 5,
  z: 0,
  angle: 0,
  roomX: 0,
  roomY: 0,
  weapon: 'bolt',
};

function currentRoom() {
  return getRoom(player.roomX, player.roomY);
}

function spawnParticle(x, y, z, color, count, speed = 2) {
  for (let i = 0; i < count; i++) {
    particles.push({
      x,
      y,
      z,
      vx: (Math.random() - 0.5) * speed,
      vy: (Math.random() - 0.5) * speed,
      vz: Math.random() * speed,
      life: 0.3 + Math.random() * 0.6,
      max: 0.3 + Math.random() * 0.6,
      color,
    });
  }
}

function damageTarget(obj, rawDamage, point) {
  const applied = Math.max(1, rawDamage * (1 - obj.armor));
  obj.hp -= applied;
  spawnParticle(point.x, point.y, point.z + 18, '#ff9c5f', 7, 1.4);
  cameraShake = Math.min(16, cameraShake + 3);
  audio.impact();
  if (obj.hp <= 0) {
    spawnParticle(point.x, point.y, point.z + 20, '#ffc56a', 26, 2.8);
    audio.break();
    return true;
  }
  return false;
}

function tryTransitionRoom() {
  const room = currentRoom();
  for (const door of room.doors) {
    if (Math.hypot(player.x - door.x, player.y - door.y) < 0.55) {
      player.roomX += door.tx;
      player.roomY += door.ty;
      if (door.dir === 'N') { player.x = 5; player.y = GRID_H - 1.4; }
      if (door.dir === 'S') { player.x = 5; player.y = 0.6; }
      if (door.dir === 'W') { player.x = GRID_W - 1.4; player.y = 5; }
      if (door.dir === 'E') { player.x = 0.6; player.y = 5; }
      roomLabel.textContent = `Room (${player.roomX},${player.roomY})`;
      break;
    }
  }
}

function obstacleAt(room, x, y) {
  const wall = room.walls.find((w) => Math.hypot(x - w.x, y - w.y) < 0.52);
  if (wall) return { type: 'wall', ref: wall };
  const debris = room.debris.find((d) => Math.hypot(x - d.x, y - d.y) < 0.48);
  if (debris) return { type: 'debris', ref: debris };
  return null;
}

function shootBolt() {
  if (shotCooldown > 0) return;
  shotCooldown = 0.13;
  const muzzle = { x: player.x + Math.cos(player.angle) * 0.36, y: player.y + Math.sin(player.angle) * 0.36, z: 35 };
  projectiles.push({
    x: muzzle.x,
    y: muzzle.y,
    z: muzzle.z,
    vx: Math.cos(player.angle) * 11,
    vy: Math.sin(player.angle) * 11,
    life: 0.7,
    dmg: 40,
  });
  spawnParticle(muzzle.x, muzzle.y, muzzle.z, '#ffd28f', 7, 1.7);
  audio.fire();
}

function powerPunch() {
  if (punchCooldown > 0) return;
  punchCooldown = 0.35;
  const room = currentRoom();
  const tx = player.x + Math.cos(player.angle) * 0.8;
  const ty = player.y + Math.sin(player.angle) * 0.8;
  const hit = obstacleAt(room, tx, ty);
  spawnParticle(tx, ty, 26, '#a6d4ff', 14, 1.9);
  if (hit) {
    const target = hit.ref;
    const broken = damageTarget(target, 95, { x: target.x, y: target.y, z: 18 });
    if (broken) {
      if (hit.type === 'wall') room.walls = room.walls.filter((w) => w !== target);
      else room.debris = room.debris.filter((d) => d !== target);
    }
  }
}

function update(dt) {
  shotCooldown = Math.max(0, shotCooldown - dt);
  punchCooldown = Math.max(0, punchCooldown - dt);
  cameraShake = Math.max(0, cameraShake - dt * 34);

  const worldMouse = screenToWorld(pointer.x, pointer.y);
  player.angle = Math.atan2(worldMouse.y - player.y, worldMouse.x - player.x);

  let moveX = 0;
  let moveY = 0;
  if (keys.has('w')) { moveX -= 1; moveY -= 1; }
  if (keys.has('s')) { moveX += 1; moveY += 1; }
  if (keys.has('a')) { moveX -= 1; moveY += 1; }
  if (keys.has('d')) { moveX += 1; moveY -= 1; }

  const len = Math.hypot(moveX, moveY) || 1;
  moveX = (moveX / len) * PLAYER_SPEED * dt;
  moveY = (moveY / len) * PLAYER_SPEED * dt;

  const room = currentRoom();
  const nextX = player.x + moveX;
  const nextY = player.y + moveY;

  if (!obstacleAt(room, nextX, player.y)) player.x = Math.min(GRID_W - 0.35, Math.max(0.35, nextX));
  if (!obstacleAt(room, player.x, nextY)) player.y = Math.min(GRID_H - 0.35, Math.max(0.35, nextY));

  tryTransitionRoom();

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;

    const hit = obstacleAt(room, p.x, p.y);
    if (hit) {
      const target = hit.ref;
      const broken = damageTarget(target, p.dmg, { x: p.x, y: p.y, z: 16 });
      if (broken) {
        if (hit.type === 'wall') room.walls = room.walls.filter((w) => w !== target);
        else room.debris = room.debris.filter((d) => d !== target);
      }
      projectiles.splice(i, 1);
      continue;
    }

    if (p.life <= 0 || p.x < -1 || p.y < -1 || p.x > GRID_W + 1 || p.y > GRID_H + 1) {
      projectiles.splice(i, 1);
      continue;
    }
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz;
    p.vz -= 0.13;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }

  if (pointer.down) {
    if (player.weapon === 'bolt') shootBolt();
    else powerPunch();
  }
}

function drawFloor(room) {
  const glow = 0.4 + Math.sin(performance.now() * 0.0009 + room.embers) * 0.12;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const p = worldToScreen(x, y);
      const c = ((x + y) % 2 === 0) ? `rgba(38,50,76,${glow})` : `rgba(29,37,58,${glow})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2);
      ctx.lineTo(p.x, p.y + TILE_H);
      ctx.lineTo(p.x - TILE_W / 2, p.y + TILE_H / 2);
      ctx.closePath();
      ctx.fillStyle = c;
      ctx.fill();

      if ((x + y) % 3 === 0) {
        ctx.strokeStyle = 'rgba(110,170,255,0.06)';
        ctx.stroke();
      }
    }
  }
}

function drawDoor(door) {
  const p = worldToScreen(door.x, door.y, 6);
  ctx.fillStyle = 'rgba(124, 200, 255, 0.35)';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + TILE_W / 3, p.y + TILE_H / 3);
  ctx.lineTo(p.x, p.y + TILE_H * 0.7);
  ctx.lineTo(p.x - TILE_W / 3, p.y + TILE_H / 3);
  ctx.closePath();
  ctx.fill();
}

function drawWall(wall) {
  const hpRatio = Math.max(0, wall.hp / wall.maxHp);
  const p = worldToScreen(wall.x, wall.y, 0);
  const h = 84;

  ctx.fillStyle = `rgba(${80 + hpRatio * 80},${70 + hpRatio * 40},${90 + hpRatio * 30},1)`;
  ctx.beginPath();
  ctx.moveTo(p.x - TILE_W / 2, p.y + TILE_H / 2);
  ctx.lineTo(p.x - TILE_W / 2, p.y + TILE_H / 2 - h);
  ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2 - h);
  ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.fillRect(p.x - TILE_W / 2, p.y + TILE_H / 2 - h, TILE_W, 9);
}

function drawDebris(item) {
  const hpRatio = Math.max(0, item.hp / item.maxHp);
  const p = worldToScreen(item.x, item.y, 0);
  const w = item.type === 'pillar' ? 36 : 44;
  const h = item.height * (0.35 + hpRatio * 0.65);
  const grad = ctx.createLinearGradient(p.x, p.y - h, p.x, p.y);
  grad.addColorStop(0, `rgba(${130 + hpRatio * 50},${120 + hpRatio * 40},${140 + hpRatio * 20},1)`);
  grad.addColorStop(1, 'rgba(40,30,42,1)');
  ctx.fillStyle = grad;
  ctx.fillRect(p.x - w / 2, p.y - h + TILE_H / 2, w, h);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + TILE_H / 2 + 6, w * 0.7, 12, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawMarine() {
  const p = worldToScreen(player.x, player.y, 0);
  const glow = 0.6 + Math.sin(performance.now() * 0.008) * 0.2;

  ctx.fillStyle = `rgba(20, 35, 80, 1)`;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 34, 22, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(p.x, p.y + 10);
  ctx.rotate(player.angle);

  ctx.fillStyle = '#224ca3';
  ctx.fillRect(-15, -34, 30, 42);
  ctx.fillStyle = '#5ca9ff';
  ctx.fillRect(-12, -29, 24, 11);

  ctx.fillStyle = '#1f2f72';
  ctx.fillRect(-24, -26, 12, 28);
  ctx.fillRect(12, -26, 12, 28);

  ctx.fillStyle = '#334f9e';
  ctx.fillRect(-14, 8, 10, 23);
  ctx.fillRect(4, 8, 10, 23);

  if (player.weapon === 'bolt') {
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(10, -14, 28, 9);
    ctx.fillStyle = '#ffd275';
    ctx.fillRect(37, -12, 6, 5);
  } else {
    ctx.fillStyle = '#6cb8ff';
    ctx.fillRect(12, -16, 16, 16);
    ctx.strokeStyle = `rgba(140, 220, 255, ${glow})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(28, -7);
    ctx.lineTo(40, -15);
    ctx.moveTo(28, -7);
    ctx.lineTo(42, -7);
    ctx.moveTo(28, -7);
    ctx.lineTo(40, 1);
    ctx.stroke();
  }

  ctx.restore();
}

function drawProjectile(p) {
  const pos = worldToScreen(p.x, p.y, p.z);
  ctx.fillStyle = '#ffd278';
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, 3.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,190,95,0.7)';
  ctx.beginPath();
  ctx.moveTo(pos.x - p.vx * 0.8, pos.y - p.vy * 0.4);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
}

function drawParticles() {
  for (const p of particles) {
    const pos = worldToScreen(p.x, p.y, p.z);
    const alpha = p.life / p.max;
    ctx.fillStyle = p.color.replace(')', `,${alpha})`).replace('rgb', 'rgba');
    ctx.fillRect(pos.x, pos.y, 3, 3);
  }
}

function render() {
  const shakeX = (Math.random() - 0.5) * cameraShake;
  const shakeY = (Math.random() - 0.5) * cameraShake;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 120, canvas.width / 2, canvas.height / 2, canvas.height * 0.75);
  vignette.addColorStop(0, 'rgba(30,36,70,0.18)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.78)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.translate(shakeX, shakeY);

  const room = currentRoom();
  drawFloor(room);

  const drawables = [];
  for (const wall of room.walls) drawables.push({ depth: wall.x + wall.y + 0.2, fn: () => drawWall(wall) });
  for (const d of room.debris) drawables.push({ depth: d.x + d.y + 0.1, fn: () => drawDebris(d) });
  drawables.push({ depth: player.x + player.y + 0.15, fn: drawMarine });
  for (const p of projectiles) drawables.push({ depth: p.x + p.y + 0.25, fn: () => drawProjectile(p) });

  drawables.sort((a, b) => a.depth - b.depth);
  for (const d of drawables) d.fn();

  for (const door of room.doors) drawDoor(door);
  drawParticles();
}

function frame(ts) {
  const dt = Math.min(0.032, (ts - lastTime) / 1000 || 0.016);
  lastTime = ts;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

window.addEventListener('keydown', (e) => {
  if (e.key === '1') {
    player.weapon = 'bolt';
    weaponLabel.textContent = 'Weapon: Bolt Gun [1]';
  }
  if (e.key === '2') {
    player.weapon = 'fist';
    weaponLabel.textContent = 'Weapon: Power Fist [2]';
  }

  keys.add(e.key.toLowerCase());
});

window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

canvas.addEventListener('mousemove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
});
canvas.addEventListener('mousedown', () => {
  pointer.down = true;
  audio.unlock();
});
window.addEventListener('mouseup', () => (pointer.down = false));

requestAnimationFrame(frame);
