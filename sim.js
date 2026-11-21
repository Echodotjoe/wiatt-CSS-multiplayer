// Shared match simulation. Runs locally for solo or on the match server online.
import * as S from './shared.js';

const TICK = 1 / 30;
const SNAP_EVERY = 1; // ticks (30 Hz)
const BOT_NAMES = ['Viper', 'Kestrel', 'Onyx', 'Rook', 'Mako', 'Juno', 'Talon', 'Nyx', 'Bishop', 'Cinder', 'Vega', 'Ghost', 'Rift', 'Sable', 'Echo', 'Drift', 'Flint', 'Hex', 'Orbit', 'Quill'];
const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
let simT = 0;
const now = () => simT;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };


export const DIFFICULTY = Object.freeze({
  easy:   { label: 'Recruit', skill: 0.5,  range: 45,  head: 0.06, dmg: 0.7 },
  normal: { label: 'Regular', skill: 1.0,  range: 80,  head: 0.25, dmg: 1.0 },
  hard:   { label: 'Veteran', skill: 1.45, range: 100, head: 0.4,  dmg: 1.0 },
  elite:  { label: 'Elite',   skill: 2.1,  range: 120, head: 0.55, dmg: 1.1 },
});
let nextId = 1;

export class Room {
  constructor(code, difficulty) {
    this.code = code;
    this.setDifficulty(difficulty || 'normal');
    this.players = new Map();
    this.tick = 0;
    this.emptySince = now();
    this.botNameIdx = (Math.random() * BOT_NAMES.length) | 0;
    this.resetMatch();
  }
  setDifficulty(key) {
    this.diffKey = Object.hasOwn(DIFFICULTY, key) ? key : 'normal';
    this.diff = DIFFICULTY[this.diffKey];
    if (this.players) for (const p of this.players.values()) if (p.isBot) p.skill = this.diff.skill * rnd(0.88, 1.12);
  }
  resetMatch() {
    this.score = { T: 0, D: 0 };
    this.round = 0;
    this.lossStreak = { T: 0, D: 0 };
    for (const p of this.players.values()) {
      p.money = S.ECON.start; p.primary = null; p.secondary = 'sidearm'; p.armor = 0; p.kit = false; stripGear(p);
      p.kills = 0; p.deaths = 0; p.alive = false;
    }
    this.startRound();
  }
  humans(team) { return [...this.players.values()].filter((p) => !p.isBot && (!team || p.team === team)); }
  bots(team) { return [...this.players.values()].filter((p) => p.isBot && (!team || p.team === team)); }
  team(team) { return [...this.players.values()].filter((p) => p.team === team); }

  newBot(team, money) {
    const name = 'BOT ' + BOT_NAMES[this.botNameIdx++ % BOT_NAMES.length];
    const p = makePlayer(name, team, null);
    p.isBot = true; p.money = money ?? S.ECON.start;
    p.skill = this.diff.skill * rnd(0.88, 1.12);
    this.players.set(p.id, p);
    return p;
  }
  rebalance() {
    for (const team of ['T', 'D']) {
      const hs = this.humans(team);
      let bs = this.bots(team);
      const need = Math.max(0, 5 - hs.length);
      while (bs.length > need) { const b = bs.pop(); this.players.delete(b.id); }
      const avg = this.team(team).length ? this.team(team).reduce((s, p) => s + p.money, 0) / this.team(team).length : S.ECON.start;
      while (bs.length < need) bs.push(this.newBot(team, Math.round(avg / 50) * 50));
    }
  }
  startRound() {
    this.round++;
    this.rebalance();
    this.phase = 'buy';
    this.timer = S.ROUND.buyTime;
    this.roundWinner = null;
    const ts = this.team('T');
    // a human attacker always gets the bomb so the player can plant (random among humans in multiplayer)
    const humans = ts.filter((q) => q.ws);
    const carrier = humans.length ? pick(humans) : ts.length ? pick(ts) : null;
    this.bomb = { state: carrier ? 'carried' : 'none', carrier: carrier?.id, x: 0, z: 0, timer: 0, site: null };
    this.planter = null;
    this.playerDefuser = null;
    this.intel = { T: new Map(), D: new Map() };
    this.radioAt = { T: 0, D: 0 };
    this.hit = null; // recent, visually confirmed defender callout
    this.nades = []; this.smokes = []; this.fires = [];
    this.targetSite = pick(['A', 'B']);
    for (const team of ['T', 'D']) {
      const list = this.team(team);
      const sites = ['A', 'A', 'B', 'B', Math.random() < 0.5 ? 'A' : 'B'];
      list.forEach((p, i) => {
        const [tx, tz] = S.SPAWNS[team][i % 5];
        const [x, z] = S.tileCenter(tx, tz);
        Object.assign(p, { x: x + rnd(-0.3, 0.3), y: 0, z: z + rnd(-0.3, 0.3), hp: 100, alive: true, using: false, useProg: 0, pitch: 0, crouch: false, sprint: false, molly: 1, adren: 1, adrenUntil: 0, healLeft: 0, burnAcc: 0 });
        p.yaw = team === 'T' ? Math.PI : 0; // T faces -z (north), D faces +z
        p.cur = p.primary ? 'primary' : 'secondary';
        p.brain = makeBrain(sites[i % 5]);
        p.stride = 0; p.moving = false; p.vy = 0; p.onGround = true;
        p.roundMoney = p.money;
        if (p.isBot) botBuy(p);
      });
      assignRoles(list, team);
    }
    this.broadcast({ t: 'event', kind: 'roundStart', round: this.round });
    this.sendSnap(true);
  }
  endRound(winner, reason) {
    if (this.phase === 'end' || this.phase === 'matchEnd') return;
    this.phase = 'end';
    this.timer = S.ROUND.endTime;
    this.roundWinner = winner;
    this.score[winner]++;
    const loser = winner === 'T' ? 'D' : 'T';
    this.lossStreak[winner] = 0;
    this.lossStreak[loser] = Math.min(this.lossStreak[loser] + 1, 4);
    const lossPay = Math.min(S.ECON.loss + S.ECON.lossBonus * (this.lossStreak[loser] - 1), S.ECON.lossMax);
    for (const p of this.players.values()) {
      if (p.team === winner) addMoney(p, S.ECON.win);
      else addMoney(p, lossPay + (p.team === 'T' && this.bomb.state === 'exploded' ? 0 : 0));
      if (p.team === 'T' && this.bomb.state === 'defused') addMoney(p, 600); // plant consolation
    }
    this.broadcast({ t: 'event', kind: 'roundEnd', winner, reason, score: this.score });
  }
  afterRound() {
    const played = this.score.T + this.score.D;
    if (this.score.T >= S.ROUND.winRounds || this.score.D >= S.ROUND.winRounds || played >= S.ROUND.halftime * 2) {
      this.phase = 'matchEnd';
      this.timer = S.ROUND.matchEndTime;
      const w = this.score.T === this.score.D ? 'draw' : this.score.T > this.score.D ? 'T' : 'D';
      this.broadcast({ t: 'event', kind: 'matchEnd', winner: w, score: this.score });
      return;
    }
    // dead players lose gear
    for (const p of this.players.values()) if (!p.alive) { p.primary = null; p.secondary = 'sidearm'; p.armor = 0; p.kit = false; stripGear(p); }
    if (played === S.ROUND.halftime) {
      for (const p of this.players.values()) {
        p.team = p.team === 'T' ? 'D' : 'T';
        p.money = S.ECON.start; p.primary = null; p.secondary = 'sidearm'; p.armor = 0; p.kit = false; stripGear(p);
      }
      this.score = { T: this.score.D, D: this.score.T };
      this.lossStreak = { T: 0, D: 0 };
      this.broadcast({ t: 'event', kind: 'halftime', score: this.score });
    }
    this.startRound();
  }

  addHuman(ws, name, pref) {
    if (this.humans().length >= 10) return null;
    const hT = this.humans('T').length, hD = this.humans('D').length;
    let team = pref === 'T' || pref === 'D' ? pref : (hT <= hD ? 'T' : 'D');
    if (this.humans(team).length >= 5) team = team === 'T' ? 'D' : 'T';
    const p = makePlayer(name, team, ws);
    if (this.phase === 'buy') {
      // take over a bot immediately
      const bots = this.bots(team);
      const b = bots.find((q) => q.brain?.role === (team === 'T' ? 'hider' : 'holder')) || bots[0];
      if (b) {
        Object.assign(p, { x: b.x, y: 0, z: b.z, yaw: b.yaw, money: b.roundMoney ?? b.money, primary: null, secondary: 'sidearm', alive: true, hp: 100, cur: 'secondary' });
        if (this.bomb.carrier === b.id) this.bomb.carrier = p.id;
        this.players.delete(b.id);
      }
      // the bomb goes to a human attacker if only bots held it
      const holder = this.players.get(this.bomb.carrier);
      if (team === 'T' && this.bomb.state === 'carried' && (!holder || !holder.ws)) this.bomb.carrier = p.id;
    } else {
      const b = this.bots(team).find((q) => q.alive) || this.bots(team)[0];
      if (b) {
        for (const key of ['x', 'y', 'z', 'yaw', 'pitch', 'crouch', 'hp', 'armor', 'alive', 'money', 'cur', 'primary', 'secondary', 'kit', 'flash', 'smoke', 'frag', 'molly', 'adren', 'adrenUntil', 'healLeft', 'att']) p[key] = b[key];
        if (this.bomb.carrier === b.id) this.bomb.carrier = p.id;
        this.players.delete(b.id);
      }
    }
    this.players.set(p.id, p);
    this.emptySince = null;
    this.broadcast({ t: 'event', kind: 'joined', name: p.name, team });
    return p;
  }
  removeHuman(p) {
    if (!this.players.has(p.id)) return;
    // a bot takes over the slot right where the player left off
    p.isBot = true; p.ws = null; p.name = 'BOT ' + p.name.slice(0, 10); p.skill = this.diff.skill;
    p.using = false;
    p.brain = makeBrain(pick(['A', 'B']));
    const occupied = new Set(this.bots(p.team).filter((q) => q !== p).map((q) => q.brain?.role));
    applyRole(p.brain, BOT_ROLES.find((role) => !occupied.has(role)) || 'holder');
    p.onGround = p.y <= S.groundAt(p.x, p.z, S.PLAYER_R, p.y) + 0.02;
    this.broadcast({ t: 'event', kind: 'left', name: p.name });
    if (!this.humans().length) this.emptySince = now();
  }

  broadcast(msg) {
    const s = [...this.players.values()].some((p) => p.ws && !p.ws.local) ? JSON.stringify(msg) : null;
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(p.ws.local ? msg : s);
  }

  // ------------------------------------------------------------------ simulation
  update(dt) {
    this.tick++;
    this.timer -= dt;
    if (this.phase === 'buy') {
      if (this.timer <= 0) { this.phase = 'live'; this.timer = S.ROUND.liveTime; this.broadcast({ t: 'event', kind: 'live' }); }
    } else if (this.phase === 'live') {
      for (const reports of Object.values(this.intel)) for (const [key, info] of reports) if (info.until <= now()) reports.delete(key);
      for (const p of this.players.values()) if (p.isBot && p.alive) tickBot(this, p, dt);
      this.updateNades(dt);
      this.updateFires(dt);
      this.updateBuffs(dt);
      this.updateObjective(dt);
      if (this.bomb.state === 'planted') {
        this.bomb.timer -= dt;
        if (this.bomb.timer <= 0) this.explode();
      } else if (this.timer <= 0) {
        this.endRound('D', 'Time ran out');
      }
      this.checkElimination();
    } else if (this.phase === 'end') {
      for (const p of this.players.values()) if (p.isBot && p.alive) tickBot(this, p, dt);
      this.updateNades(dt);
      this.updateFires(dt);
      this.updateBuffs(dt);
      if (this.bomb.state === 'planted') { this.bomb.timer -= dt; if (this.bomb.timer <= 0) this.explode(); }
      if (this.timer <= 0) this.afterRound();
    } else if (this.phase === 'matchEnd') {
      if (this.timer <= 0) this.resetMatch();
    }
    if (this.tick % SNAP_EVERY === 0) this.sendSnap();
  }
  updateObjective(dt) {
    const b = this.bomb;
    // pick up dropped bomb
    if (b.state === 'dropped') {
      for (const p of this.team('T')) if (p.alive && Math.hypot(p.x - b.x, p.z - b.z) < 1.4) {
        b.state = 'carried'; b.carrier = p.id;
        this.sendTo(p, { t: 'event', kind: 'bombPickup' });
        break;
      }
    }
    for (const p of this.players.values()) {
      if (!p.alive || !p.using) { p.useProg = 0; continue; }
      const moved = Math.hypot(p.x - (p.useX ?? p.x), p.z - (p.useZ ?? p.z)) > 0.25;
      if (moved) { p.useProg = 0; p.useX = p.x; p.useZ = p.z; continue; }
      if (p.team === 'T' && b.state === 'carried' && b.carrier === p.id && S.inSite(p.x, p.z) && p.y < 0.3) {
        p.useProg += dt;
        if (p.useProg >= S.ROUND.plantTime) {
          b.state = 'planted'; b.x = p.x; b.z = p.z; b.y = 0; b.timer = S.ROUND.bombTime; b.site = S.inSite(p.x, p.z); b.carrier = null;
          p.using = false; p.useProg = 0; addMoney(p, S.ECON.plant);
          this.planter = p.id;
          this.broadcast({ t: 'event', kind: 'planted', site: b.site, by: p.name });
        }
      } else if (p.team === 'D' && b.state === 'planted' && Math.hypot(p.x - b.x, p.z - b.z) < 1.8 && Math.abs(p.y - (b.y || 0)) < 1.2) {
        p.useProg += dt;
        if (p.useProg >= (p.kit ? S.ROUND.defuseKitTime : S.ROUND.defuseTime)) {
          b.state = 'defused'; p.using = false; p.useProg = 0; addMoney(p, S.ECON.defuse);
          this.broadcast({ t: 'event', kind: 'defused', by: p.name });
          this.endRound('D', 'Bomb defused');
        }
      } else p.useProg = 0;
    }
  }
  explode() {
    const b = this.bomb;
    b.state = 'exploded';
    this.broadcast({ t: 'event', kind: 'exploded', x: b.x, z: b.z });
    // The attackers win the moment the bomb goes off. This has to be decided BEFORE the blast damage is
    // applied: otherwise attackers standing near their own bomb die in the blast, the "attackers
    // eliminated" check fires first and the defenders are handed the round.
    this.endRound('T', 'Target destroyed');
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < 22) this.damage(p, null, Math.round(500 * (1 - d / 22) ** 1.5), false, 'bomb');
    }
  }
  checkElimination() {
    if (this.phase !== 'live') return;
    const tAlive = this.team('T').some((p) => p.alive);
    const dAlive = this.team('D').some((p) => p.alive);
    if (!dAlive) this.endRound('T', 'Defenders eliminated');
    else if (!tAlive && this.bomb.state !== 'planted' && this.bomb.state !== 'exploded') this.endRound('D', 'Attackers eliminated');
  }
  damage(target, attacker, dmg, head, weapon, burn) {
    if (!target.alive) return;
    let hpDmg = dmg;
    if (target.armor > 0 && weapon !== 'bomb' && weapon !== 'fire') {
      const absorbed = Math.min(target.armor, dmg * 0.45);
      target.armor = Math.max(0, Math.round(target.armor - absorbed));
      hpDmg = dmg - absorbed;
    }
    hpDmg = Math.max(1, Math.round(hpDmg));
    target.hp -= hpDmg;
    if (attacker) {
      if (!burn || target.hp <= 0) this.sendTo(attacker, { t: 'hitConfirm', head, kill: target.hp <= 0 });
      if (target.isBot && !burn && attacker.team !== target.team) {
        const yaw = Math.atan2(attacker.x - target.x, attacker.z - target.z) + rnd(-0.22, 0.22);
        target.brain.damageLook = { yaw, until: now() + 1.1 };
      }
    }
    this.sendTo(target, { t: 'hurt', dmg: hpDmg, burn: burn ? 1 : 0, fx: attacker ? attacker.x : target.x, fz: attacker ? attacker.z : target.z });
    if (target.isBot && burn) target.brain.burning = now() + 0.4;
    if (target.hp <= 0) {
      target.hp = 0; target.alive = false; target.using = false; target.deaths++;
      if (this.phase === 'live') this.report(target.team, `loss:${target.id}`, { kind: 'loss', x: target.x, z: target.z, until: now() + 8 });
      if (attacker && attacker !== target) {
        attacker.kills++;
        if (attacker.team !== target.team) addMoney(attacker, S.WEAPONS[weapon]?.reward ?? 300);
      }
      if (this.bomb.state === 'carried' && this.bomb.carrier === target.id) {
        this.bomb.state = 'dropped'; this.bomb.carrier = null; this.bomb.y = 0;
        let bx = target.x, bz = target.z, tx = Math.floor(bx / S.TILE), tz = Math.floor(bz / S.TILE);
        if (S.navBlocked(tx, tz) || S.propTop(bx, bz) > 0) { const [nx, nz] = nearTile(bx, bz, 2); [bx, bz] = S.tileCenter(nx, nz); }
        this.bomb.x = bx; this.bomb.z = bz;
      }
      this.broadcast({ t: 'kill', killer: attacker?.name ?? 'World', kt: attacker?.team, victim: target.name, vt: target.team, w: weapon, head, vid: target.id });
      this.checkElimination();
    }
  }
  fire(p, o, dirs, wKey) {
    const w = S.WEAPONS[wKey];
    if (!Array.isArray(dirs[0])) dirs = [dirs];
    const hits = new Map(), ends = [];
    let anyHit = false;
    for (const d of dirs) {
      const tWall = S.rayWorld(o, d, 250);
      let best = null;
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const h = S.rayPlayer(o, d, q);
        if (h && h.t < tWall && (!best || h.t < best.t)) best = { ...h, q };
      }
      const tEnd = best ? best.t : tWall;
      ends.push([r2(o[0] + d[0] * tEnd), r2(o[1] + d[1] * tEnd), r2(o[2] + d[2] * tEnd), best ? 1 : 0]);
      if (best) {
        anyHit = true;
        if (best.q.team !== p.team) {
          let dmg = w.dmg;
          if (best.t > w.range) dmg *= Math.max(w.falloff, 1 - (best.t - w.range) / (w.range * 2));
          if (best.head) dmg *= w.head;
          if (p.isBot && !best.q.isBot) dmg *= this.diff.dmg;
          const hh = hits.get(best.q) || { dmg: 0, head: false };
          hh.dmg += dmg; hh.head = hh.head || best.head; hits.set(best.q, hh);
        }
      }
    }
    const e = ends[0];
    const slot = S.WEAPONS[wKey].slot;
    const quiet = S.ATTACH[p.att?.[slot]?.muzzle]?.quiet;
    this.broadcast({ t: 'shot', id: p.id, o, e, ex: ends.length > 1 ? ends.slice(1) : undefined, w: wKey, hitP: !!e[3], q: quiet ? 1 : 0 });
    this.sound(p.team, 'shot', p.x, p.z, quiet ? 14 : 38);
    for (const [q, h] of hits) this.damage(q, p, h.dmg, h.head, wKey);
  }
  report(team, key, info) {
    const reports = this.intel[team];
    const old = reports.get(key);
    // Identical callouts refresh but do not keep picking new investigators.
    if (old && old.until > now() && Math.hypot(old.x - info.x, old.z - info.z) < 5) {
      old.until = info.until;
      return;
    }
    const options = this.bots(team).filter((p) => p.alive && !p.using && this.bomb.carrier !== p.id && !p.brain.target &&
      (['rusher', 'peeker'].includes(p.brain.role) || Math.hypot(p.x - info.x, p.z - info.z) < (info.kind === 'loss' ? 13 : 8)));
    options.sort((a, b) => Math.hypot(a.x - info.x, a.z - info.z) - Math.hypot(b.x - info.x, b.z - info.z));
    const choice = options.find((p) => p.id !== info.from && Math.hypot(p.x - info.x, p.z - info.z) < (info.kind === 'loss' ? 38 : 32));
    reports.set(key, { ...info, key, assigned: choice?.id });
    if (now() >= this.radioAt[team]) {
      this.radioAt[team] = now() + (info.kind === 'loss' ? 1.7 : 3);
      const site = S.inSite(info.x, info.z);
      const area = site ? `Site ${site}` : info.z > 65 ? 'Attacker approach' : info.z < 10 ? 'Defender approach' : info.x < 23 ? 'Tunnels' : info.x > 64 ? 'Long' : 'Mid';
      for (const p of this.humans(team)) this.sendTo(p, { t: 'event', kind: 'radio', call: info.kind, area });
    }
  }
  sound(team, kind, x, z, radius) {
    if (this.phase !== 'live') return;
    for (const p of this.players.values()) {
      if (!p.isBot || !p.alive || p.team === team) continue;
      const b = p.brain, d = Math.hypot(p.x - x, p.z - z);
      if (d > radius || (b.heard && b.heard.sample > now() - 0.7 && (kind !== 'shot' || b.heard.kind === 'shot'))) continue;
      const occluded = !S.losClear(p.x, p.z, x, z);
      if (d > radius * (occluded ? (kind === 'step' ? 0.4 : 0.58) : 1)) continue;
      const yaw = Math.atan2(x - p.x, z - p.z) + rnd(-1, 1) * (occluded ? 0.5 : 0.24);
      const estimate = d * rnd(0.8, 1.16);
      b.heard = { kind, x: p.x + Math.sin(yaw) * estimate, z: p.z + Math.cos(yaw) * estimate, sample: now(), until: now() + (kind === 'step' ? 2.5 : 3.6) };
    }
  }
  footstep(p, distance) {
    if (!(distance > 0)) return;
    p.stride = (p.stride || 0) + distance;
    if (p.stride < (p.sprint ? 2.3 : 1.85)) return;
    p.stride = 0;
    if (p.y - S.groundAt(p.x, p.z, S.PLAYER_R, p.y) > 0.12) return;
    this.sound(p.team, 'step', p.x, p.z, p.crouch ? 2.6 : p.sprint ? 17 : 10);
  }
  throwNade(p, k, o, d) {
    if (!p.alive || !(p[k] > 0) || (this.phase !== 'live' && this.phase !== 'end')) return;
    if (now() - p.lastThrow < 0.6) return;
    p.lastThrow = now(); p[k]--;
    const sp = S.NADE.speed;
    this.nades.push({ id: nextId++, k, owner: p.id, x: o[0], y: o[1], z: o[2], vx: d[0] * sp, vy: d[1] * sp + 2, vz: d[2] * sp, t: 0, rest: 0 });
    this.broadcast({ t: 'event', kind: 'throw', id: p.id, k });
  }
  throwAt(p, k, tx, tz) {
    // ballistic lob that lands near (tx, tz)
    const dx = tx - p.x, dz = tz - p.z, dh = Math.hypot(dx, dz) || 1;
    const T = Math.max(0.5, Math.min(1.5, dh / 13));
    const vh = dh / T, g = S.NADE.gravity, y0 = p.y + S.eyeH(p.crouch);
    const vy = (0.3 - y0 + 0.5 * g * T * T) / T;
    const sp = S.NADE.speed;
    if (!(p[k] > 0)) return;
    const yaw = Math.atan2(dx, dz);
    p.yaw = yaw;
    this.throwNade(p, k, [p.x, y0, p.z], [Math.sin(yaw) * vh / sp, (vy - 2) / sp, Math.cos(yaw) * vh / sp]);
  }
  updateNades(dt) {
    const g = S.NADE.gravity;
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const n = this.nades[i];
      n.t += dt;
      const sub = 4, h = dt / sub;
      for (let k = 0; k < sub; k++) {
        n.vy -= g * h;
        const nx = n.x + n.vx * h;
        if (S.solidPoint(nx, n.y, n.z)) n.vx *= -0.45; else n.x = nx;
        const nz = n.z + n.vz * h;
        if (S.solidPoint(n.x, n.y, nz)) n.vz *= -0.45; else n.z = nz;
        n.y += n.vy * h;
        const gy = S.propTop(n.x, n.z) + 0.08;
        if (n.y < gy) {
          n.y = gy;
          if (n.k === 'molly' && n.t > 0.12) { n.landed = true; break; }
          n.vy = Math.abs(n.vy) > 1.2 ? -n.vy * 0.35 : 0; n.vx *= 0.7; n.vz *= 0.7;
        }
      }
      const speed = Math.hypot(n.vx, n.vy, n.vz);
      if (speed < 0.6) n.rest += dt;
      if (n.k === 'flash' && n.t >= S.NADE.flashFuse) { this.detonateFlash(n); this.nades.splice(i, 1); }
      else if (n.k === 'frag' && n.t >= S.FRAG.fuse) { this.detonateFrag(n); this.nades.splice(i, 1); }
      else if (n.k === 'molly' && (n.landed || n.t >= S.FIRE.fuse)) {
        this.nades.splice(i, 1);
        const gy = S.propTop(n.x, n.z);
        const inSmoke = this.smokes.some((m) => m.grow > 0.4 && Math.hypot(m.x - n.x, m.z - n.z) < S.NADE.smokeR);
        if (inSmoke) { this.broadcast({ t: 'event', kind: 'fizzle', x: n.x, z: n.z }); continue; }
        if (n.y - gy > 2.5) { this.broadcast({ t: 'event', kind: 'fizzle', x: n.x, z: n.z }); continue; } // burst in the air
        this.fires.push({ id: n.id, x: n.x, y: gy, z: n.z, t: S.FIRE.time, owner: n.owner, team: this.players.get(n.owner)?.team });
        this.broadcast({ t: 'event', kind: 'ignite', x: n.x, y: gy, z: n.z });
      }
      else if (n.k === 'smoke' && (n.t >= S.NADE.smokeFuse || n.rest > 0.4)) {
        this.smokes.push({ id: n.id, x: n.x, z: n.z, t: S.NADE.smokeTime, grow: 0 });
        this.broadcast({ t: 'event', kind: 'smoke', x: n.x, z: n.z });
        this.nades.splice(i, 1);
      }
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i]; s.t -= dt; s.grow = Math.min(1, s.grow + dt / 1.2);
      if (s.t <= 0) this.smokes.splice(i, 1);
    }
  }
  updateFires(dt) {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t -= dt;
      // smoke puts the fire out
      if (this.smokes.some((m) => m.grow > 0.5 && Math.hypot(m.x - f.x, m.z - f.z) < S.NADE.smokeR)) f.t = Math.min(f.t, 0.4);
      if (f.t <= 0) { this.fires.splice(i, 1); continue; }
      const owner = this.players.get(f.owner);
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (p.team === f.team && p !== owner) continue; // no team damage
        if (Math.hypot(p.x - f.x, p.z - f.z) > S.FIRE.r || Math.abs(p.y - f.y) > 1.1) continue;
        p.burnAcc = (p.burnAcc || 0) + S.FIRE.dps * dt * (p.isBot ? 1 : this.diff.dmg);
        if (p.burnAcc >= 6) { const d = p.burnAcc; p.burnAcc = 0; this.damage(p, owner && owner !== p ? owner : null, d, false, 'fire', true); }
      }
    }
  }
  updateBuffs(dt) {
    for (const p of this.players.values()) {
      if (!p.alive || !(p.healLeft > 0)) continue;
      const h = Math.min(p.healLeft, (S.ADREN.heal / S.ADREN.healTime) * dt);
      p.healLeft -= h; p.hp = Math.min(100, p.hp + h);
    }
  }
  useAdrenaline(p) {
    if (!p.alive || !(p.adren > 0) || (this.phase !== 'live' && this.phase !== 'end')) return;
    p.adren--; p.adrenUntil = now() + S.ADREN.time; p.healLeft = S.ADREN.heal;
    this.broadcast({ t: 'event', kind: 'adren', id: p.id });
  }
  detonateFrag(n) {
    const c = [n.x, n.y + 0.25, n.z], owner = this.players.get(n.owner);
    this.broadcast({ t: 'event', kind: 'frag', x: n.x, y: n.y, z: n.z });
    this.sound(owner?.team, 'blast', n.x, n.z, 34);
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (owner && p.team === owner.team && p !== owner) continue; // no team damage
      const H = p.crouch ? S.PLAYER_H_CROUCH : S.PLAYER_H;
      // closest exposed body part: feet, chest or head must have a clear line to the blast
      let best = Infinity;
      for (const fy of [0.25, H * 0.55, H - 0.15]) {
        const q = [p.x, p.y + fy, p.z], d = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
        if (d < best && d < S.FRAG.r && S.segClear(c, q)) best = d;
      }
      if (best < S.FRAG.r) {
        const k = 1 - best / S.FRAG.r, dmg = S.FRAG.dmg * k * k * (p.isBot ? 1 : this.diff.dmg);
        if (dmg >= 2) this.damage(p, owner || null, dmg, false, 'frag');
      }
    }
  }
  detonateFlash(n) {
    this.broadcast({ t: 'event', kind: 'flash', x: n.x, y: n.y, z: n.z });
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.isBot && p.id === n.owner) continue; // bots look away from their own flashes
      const ex = p.x, ey = p.y + S.EYE, ez = p.z;
      const dx = n.x - ex, dy = n.y - ey, dz = n.z - ez, d = Math.hypot(dx, dy, dz);
      if (d > S.NADE.flashRange) continue;
      if (!S.losClear(ex, ez, n.x, n.z) && Math.hypot(dx, dz) > 0.8) continue;
      const fx = Math.sin(p.yaw) * Math.cos(p.pitch), fy = Math.sin(p.pitch), fz = Math.cos(p.yaw) * Math.cos(p.pitch);
      const dot = (fx * dx + fy * dy + fz * dz) / (d || 1);
      const face = dot > 0.6 ? 1 : dot > 0.1 ? 0.55 : 0.18;
      const amt = Math.min(1, face * (1 - d / S.NADE.flashRange) * 1.35);
      if (amt < 0.08) continue;
      const dur = 0.3 + amt * 3.4;
      if (p.isBot) {
        if (p.team === this.players.get(n.owner)?.team) continue; // bots don't flash their own team
        p.brain.blindUntil = now() + dur; p.brain.target = null;
        p.brain.damageLook = { yaw: Math.atan2(n.x - p.x, n.z - p.z) + Math.PI, until: now() + dur };
      } else this.sendTo(p, { t: 'flashed', amt, dur });
    }
  }
  sendTo(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(p.ws.local ? msg : JSON.stringify(msg)); }
  sendSnap(force) {
    const list = [...this.players.values()].map((p) => ({
      id: p.id, n: p.name, tm: p.team, b: p.isBot ? 1 : 0,
      x: r2(p.x), y: r2(p.y), z: r2(p.z), yw: r3(p.yaw), pt: r3(p.pitch),
      hp: Math.ceil(p.hp), a: p.alive ? 1 : 0, w: p.cur === 'primary' && p.primary ? p.primary : p.secondary,
      k: p.kills, d: p.deaths, mv: p.moving ? 1 : 0, u: p.useProg > 0 ? 1 : 0, ar: p.armor > 0 ? 1 : 0, m: p.money,
      cr: p.crouch ? 1 : 0, sp: p.sprint ? 1 : 0, ln: r2(p.ln || 0), ad: (p.adrenUntil || 0) > now() ? 1 : 0, ro: p.isBot ? ROLE_LABEL[p.brain?.role] || '' : '',
    }));
    const b = this.bomb;
    const base = {
      t: 'snap', ph: this.phase, tm: r2(this.timer), r: this.round, sc: this.score, ts: this.targetSite,
      bomb: { s: b.state, c: b.carrier, x: r2(b.x), y: r2(b.y || 0), z: r2(b.z), tm: r2(b.timer), site: b.site },
      pl: list, room: this.code,
      nd: this.nades.map((n) => ({ id: n.id, k: n.k, x: r2(n.x), y: r2(n.y), z: r2(n.z) })),
      sm: this.smokes.map((m) => ({ id: m.id, x: r2(m.x), z: r2(m.z), t: r2(m.t), grow: r2(m.grow) })),
      fi: this.fires.map((f) => ({ id: f.id, x: r2(f.x), y: r2(f.y), z: r2(f.z), t: r2(f.t) })),
    };
    for (const p of this.players.values()) {
      if (!p.ws || p.ws.readyState !== 1) continue;
      const you = { id: p.id, money: p.money, armor: p.armor, hp: Math.ceil(p.hp), kit: p.kit, primary: p.primary, secondary: p.secondary, team: p.team, alive: p.alive, att: p.att, flash: p.flash, smoke: p.smoke, frag: p.frag, molly: p.molly, adren: p.adren, adrT: Math.max(0, (p.adrenUntil || 0) - now()), useProg: p.useProg, force: force ? 1 : 0, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch };
      const out = { ...base, you };
      p.ws.send(p.ws.local ? out : JSON.stringify(out));
    }
  }

  // ------------------------------------------------------------------ client messages
  onMessage(p, m) {
    if (m.t === 'state') {
      if (!p.alive || this.phase === 'buy' || this.phase === 'matchEnd') { if (p.alive) { p.yaw = +m.yaw || 0; p.pitch = +m.pitch || 0; } return; }
      const nx = +m.x, nz = +m.z;
      if (!Number.isFinite(nx) || !Number.isFinite(nz)) return;
      const dist = Math.hypot(nx - p.x, nz - p.z);
      const ny = Math.max(0, Math.min(4, +m.y || 0));
      const validMove = dist < 4 && !S.collides(nx, nz, S.PLAYER_R * 0.8, ny);
      if (validMove) { p.x = nx; p.z = nz; }
      p.y = ny;
      p.crouch = !!m.cr; p.sprint = !!m.sp;
      p.yaw = +m.yaw || 0; p.pitch = Math.max(-1.5, Math.min(1.5, +m.pitch || 0));
      { // lean: clamp and refuse to lean through walls
        let ln = Math.max(-1, Math.min(1, +m.ln || 0));
        if (p.sprint) ln = 0;
        if (Math.abs(ln) > 0.05) { const e = [p.x, p.y + S.eyeH(p.crouch), p.z], [lx, lz] = S.leanOff(p.yaw, ln); if (!S.segClear(e, [e[0] + lx * 1.3, e[1], e[2] + lz * 1.3])) ln *= 0.4; }
        p.ln = ln;
      }
      p.moving = !!m.mv;
      if (validMove) this.footstep(p, dist);
      if (m.c === 'primary' || m.c === 'secondary') p.cur = m.c;
    } else if (m.t === 'shoot') {
      if (!p.alive || this.phase === 'buy' || this.phase === 'matchEnd') return;
      const wKey = m.w;
      if (wKey !== p.primary && wKey !== p.secondary) return;
      const w = S.WEAPONS[wKey];
      const t = now();
      p.sprint = false;
      if (t - (p.lastShot || 0) < (60 / w.rpm) * 0.75) return;
      p.lastShot = t;
      let o = Array.isArray(m.o) ? m.o.map(Number) : null;
      if (!o || o.some((v) => !Number.isFinite(v)) || Math.hypot(o[0] - p.x, o[2] - p.z) > 2) o = [p.x, p.y + S.EYE, p.z];
      let d = Array.isArray(m.d) ? m.d.map(Number) : [0, 0, 1];
      const l = Math.hypot(...d) || 1; d = d.map((v) => v / l);
      if (w.pellets && Array.isArray(m.ds)) {
        const dirs = m.ds.slice(0, w.pellets).map((v) => { const a = Array.isArray(v) ? v.map(Number) : [0, 0, 1]; const L = Math.hypot(...a) || 1; return a.map((x) => x / L); });
        this.fire(p, o, dirs, wKey);
      } else this.fire(p, o, d, wKey);
    } else if (m.t === 'ability') {
      if (m.k === 'adren') this.useAdrenaline(p);
    } else if (m.t === 'throw') {
      if (m.k !== 'flash' && m.k !== 'smoke' && m.k !== 'molly' && m.k !== 'frag') return;
      let o = Array.isArray(m.o) ? m.o.map(Number) : null;
      if (!o || o.some((v) => !Number.isFinite(v))) o = [p.x, p.y + S.EYE, p.z];
      let d = Array.isArray(m.d) ? m.d.map(Number) : [0, 0, 1];
      const l = Math.hypot(...d) || 1; d = d.map((v) => v / l);
      this.throwNade(p, m.k, o, d);
    } else if (m.t === 'buy') {
      if (this.phase !== 'buy' || !p.alive) return;
      buyItem(p, m.item, m.slot);
      this.sendSnap();
    } else if (m.t === 'use') {
      p.using = !!m.on; p.useX = p.x; p.useZ = p.z;
      if (!p.using) p.useProg = 0;
    }
  }
}

function makePlayer(name, team, ws) {
  return {
    id: nextId++, name, team, ws, isBot: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hp: 100, armor: 0, alive: false,
    money: S.ECON.start, primary: null, secondary: 'sidearm', cur: 'secondary', kit: false, kills: 0, deaths: 0,
    lastShot: 0, moving: false, using: false, useProg: 0, brain: null, skill: 1,
    att: { primary: {}, secondary: {} }, flash: 0, smoke: 0, frag: 0, lastThrow: 0,
    crouch: false, sprint: false, molly: 1, adren: 1, adrenUntil: 0, healLeft: 0, burnAcc: 0,
  };
}
function addMoney(p, v) { p.money = Math.min(S.ECON.max, p.money + v); }
function stripGear(p) { p.att = { primary: {}, secondary: {} }; p.flash = 0; p.smoke = 0; p.frag = 0; }
function buyItem(p, item, slot) {
  const w = S.WEAPONS[item];
  if (w) {
    if (p[w.slot] === item || p.money < w.price) return false;
    p.money -= w.price; p[w.slot] = item; p.cur = w.slot; p.att[w.slot] = {}; return true;
  }
  if (item === 'flash' || item === 'smoke' || item === 'frag') {
    const g = S.GEAR[item];
    if (p[item] >= g.max || p.money < g.price) return false;
    p.money -= g.price; p[item]++; return true;
  }
  if (typeof item === 'string' && item.startsWith('att:')) {
    const a = S.ATTACH[item.slice(4)], ws = slot === 'secondary' ? 'secondary' : 'primary', wk = p[ws];
    if (!a || !wk || !a.for.includes(wk) || p.money < a.price || p.att[ws][a.slot] === item.slice(4)) return false;
    p.money -= a.price; p.att[ws][a.slot] = item.slice(4); return true;
  }
  if (item === 'armor' && p.armor < 100 && p.money >= S.GEAR.armor.price) { p.money -= S.GEAR.armor.price; p.armor = 100; return true; }
  if (item === 'kit' && p.team === 'D' && !p.kit && p.money >= S.GEAR.kit.price) { p.money -= S.GEAR.kit.price; p.kit = true; return true; }
  return false;
}
function botBuy(p) {
  const m = p.money;
  if (!p.primary) {
    const r = Math.random();
    if (m >= 5600 && r < 0.15) buyItem(p, 'longbow');
    else if (m >= 4400 && r < 0.3) buyItem(p, r < 0.22 ? 'warden' : 'sentinel');
    else if (m >= 3700) buyItem(p, 'raptor');
    else if (m >= 2700 && r < 0.6) buyItem(p, r < 0.35 ? 'raptor' : 'bulldog');
    else if (m >= 2100 && r < 0.75) buyItem(p, r < 0.45 ? 'bulldog' : r < 0.6 ? 'breacher' : 'vector');
    else if (m >= 1600 && r < 0.5) buyItem(p, Math.random() < 0.5 ? 'vector' : 'breacher');
  }
  if (p.money >= 1000 && p.armor < 100 && (p.primary || p.money > 2000 || Math.random() < 0.3)) buyItem(p, 'armor');
  if (p.team === 'D' && p.money >= 400 && p.primary) buyItem(p, 'kit');
  if (!p.primary && p.money >= 700 && p.secondary === 'sidearm' && Math.random() < 0.5) buyItem(p, Math.random() < 0.55 ? 'cannon' : 'hornet');
  if (p.money >= 200 && p.flash < 1 && Math.random() < 0.65) buyItem(p, 'flash');
  if (p.team === 'T' && p.money >= 300 && p.smoke < 1 && Math.random() < 0.55) buyItem(p, 'smoke');
  if (p.team === 'T' && p.money >= 2200 && p.smoke === 1 && Math.random() < 0.4) buyItem(p, 'smoke');
  if (p.money >= 300 && p.frag < 1 && (p.primary || p.money > 1500) && Math.random() < 0.45) buyItem(p, 'frag');
  if (p.money >= 2600 && p.frag === 1 && p.primary && Math.random() < 0.3) buyItem(p, 'frag');
  p.cur = p.primary ? 'primary' : 'secondary';
}

// ------------------------------------------------------------------ bot AI
function makeBrain(site) {
  return {
    site, think: now() + rnd(0, 0.12), planAt: 0, path: null, pi: 0, goal: null,
    target: null, hold: null, burst: 0, blocked: new Map(), stamina: 1, staminaDelay: 0,
  };
}
function eyeOf(p) { const [lx, lz] = S.leanOff(p.yaw || 0, p.ln || 0); return [p.x + lx, p.y + S.eyeH(p.crouch), p.z + lz]; }
function inFire(room, x, z, pad = 0) { for (const f of room.fires) if (f.t > 0.5 && Math.hypot(x - f.x, z - f.z) < S.FIRE.r + pad) return f; return null; }
// which part of q (if any) the bot can see over cover: 'head' | 'body' | null
function visiblePart(room, bot, q) {
  const e = eyeOf(bot), H = q.crouch ? S.PLAYER_H_CROUCH : S.PLAYER_H;
  const [lx, lz] = S.leanOff(q.yaw || 0, q.ln || 0);
  if (S.segClear(e, [q.x + lx, q.y + H - 0.15, q.z + lz])) {
    return S.segClear(e, [q.x + lx * 0.6, q.y + H * 0.6, q.z + lz * 0.6]) || S.segClear(e, [q.x, q.y + H * 0.3, q.z]) ? 'body' : 'head';
  }
  // body visible even if head hidden (e.g. leaning back behind a corner)
  if (Math.abs(q.ln || 0) > 0.3 && S.segClear(e, [q.x, q.y + H * 0.35, q.z])) return 'body';
  return null;
}
function botSee(room, bot) {
  if (now() < (bot.brain.blindUntil || 0)) return null;
  let best = null, bd = Infinity;
  for (const q of room.players.values()) {
    if (!q.alive || q.team === bot.team) continue;
    const dx = q.x - bot.x, dz = q.z - bot.z, d = Math.hypot(dx, dz);
    if (d > room.diff.range) continue;
    const yawTo = Math.atan2(dx, dz);
    if (Math.abs(angDiff(bot.yaw, yawTo)) > Math.PI / 4) continue;
    if (!S.losClear(bot.x, bot.z, q.x, q.z)) continue;
    if (S.smokeBlocks(bot.x, bot.z, q.x, q.z, room.smokes)) continue;
    const part = visiblePart(room, bot, q);
    if (!part) continue;
    const score = q.id === bot.brain.target?.id ? d * 0.82 : d;
    if (score < bd) { bd = score; best = q; bot.brain.seePart = part; }
  }
  return best;
}
function setGoal(room, bot, tx, tz, force = false) {
  const b = bot.brain;
  const same = b.goal?.[0] === tx && b.goal?.[1] === tz;
  if (!force && same && (b.path || now() < b.retryAt)) return;
  const sx = Math.floor(bot.x / S.TILE), sz = Math.floor(bot.z / S.TILE);
  for (const [edge, until] of b.blocked) if (until <= now()) b.blocked.delete(edge);
  const costs = new Map();
  if (!(room.bomb.state === 'planted' && room.bomb.timer < 12)) {
    for (const f of room.fires) if (f.t > 0.7 && (f.team !== bot.team || f.owner === bot.id)) {
      const r = S.FIRE.r + 0.8;
      for (let z = Math.floor((f.z - r) / S.TILE); z <= Math.floor((f.z + r) / S.TILE); z++)
        for (let x = Math.floor((f.x - r) / S.TILE); x <= Math.floor((f.x + r) / S.TILE); x++) {
          const [cx, cz] = S.tileCenter(x, z);
          if (!S.solidAt(x, z) && Math.hypot(cx - f.x, cz - f.z) < r) costs.set(z * S.W + x, 12);
        }
    }
  }
  b.goal = [tx, tz];
  b.path = S.findPath(sx, sz, tx, tz, { costs, blocked: b.blocked });
  b.pi = b.path?.length === 1 ? 0 : 1;
  b.atGoal = false; b.progress = null; b.pauseUntil = 0; b.pauseAt = -1;
  b.retryAt = now() + rnd(0.45, 0.85);
}
function botMove(bot, dx, dz) {
  const ox = bot.x, oz = bot.z;
  [bot.x, bot.z] = S.moveCollide(ox, oz, dx, dz, S.PLAYER_R, bot.y);
  const dist = Math.hypot(bot.x - ox, bot.z - oz);
  bot.moving ||= dist > 0.003;
  return dist;
}
function tickBot(room, bot, dt) {
  const b = bot.brain, ox = bot.x, oz = bot.z;
  b.wasSprinting = bot.sprint;
  bot.moving = false; bot.sprint = false;
  updateBot(room, bot, dt);
  const g = S.groundAt(bot.x, bot.z, S.PLAYER_R, bot.y);
  if (bot.onGround && g < bot.y - 0.02) bot.onGround = false;
  if (bot.onGround) bot.y = g;
  else {
    bot.y += (bot.vy - 0.5 * S.GRAV * dt) * dt;
    bot.vy -= S.GRAV * dt;
    const floor = S.groundAt(bot.x, bot.z, S.PLAYER_R, Math.max(0, bot.y));
    if (bot.vy <= 0 && bot.y <= floor) { bot.y = floor; bot.vy = 0; bot.onGround = true; }
  }
  if (bot.sprint && bot.moving) {
    b.staminaDelay = 0.8;
    if (bot.adrenUntil <= now()) b.stamina = Math.max(0, b.stamina - dt / 6);
    if (!b.stamina) b.exhausted = true;
  } else if ((b.staminaDelay -= dt) <= 0) {
    b.stamina = Math.min(1, b.stamina + dt / 3.5);
    if (b.stamina > 0.3) b.exhausted = false;
  }
  room.footstep(bot, Math.hypot(bot.x - ox, bot.z - oz));
}
function randSiteTile(site) {
  const s = S.SITES[site];
  for (let i = 0; i < 30; i++) {
    const tx = Math.floor(rnd(s.x0 + 1, s.x1)), tz = Math.floor(rnd(s.z0 + 1, s.z1));
    if (!S.navBlocked(tx, tz)) return [tx, tz];
  }
  return [Math.floor((s.x0 + s.x1) / 2), Math.floor((s.z0 + s.z1) / 2)];
}
function nearTile(x, z, r) {
  for (let i = 0; i < 30; i++) {
    const tx = Math.floor(x / S.TILE + rnd(-r, r)), tz = Math.floor(z / S.TILE + rnd(-r, r));
    if (!S.navBlocked(tx, tz)) return [tx, tz];
  }
  return [Math.floor(x / S.TILE), Math.floor(z / S.TILE)];
}
// ------------------------------------------------------------------ bot roles
// Roles change routes, exposure, stance, and reactions; they are not difficulty levels.
const ROLE_LABEL = { rusher: 'Rusher', holder: 'Holder', peeker: 'Peeker', camper: 'Camper', hider: 'Hider' };
const BOT_ROLES = Object.keys(ROLE_LABEL);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
// nearest walkable tile to (tx, tz)
function openTile(tx, tz) {
  if (!S.navBlocked(tx, tz)) return [tx, tz];
  for (let r = 1; r < 6; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    if (!S.navBlocked(tx + dx, tz + dz)) return [tx + dx, tz + dz];
  }
  return [tx, tz];
}
const LANES = {
  A: { entry: [39, 13], side: [29, 11], cover: [34, 6], back: [35, 2], watch: [39, 10], push: [37, 22] },
  B: { entry: [3, 14], side: [12, 11], cover: [6, 6], back: [6, 3], watch: [4, 10], push: [4, 23] },
};
function applyRole(brain, role) { brain.role = role; brain.aggr = role === 'rusher'; }
function assignRoles(list, team) {
  const bots = shuffle(list.filter((p) => p.isBot));
  const pool = team === 'D' ? ['holder', 'camper', 'hider', 'peeker', 'rusher'] : ['rusher', 'peeker', 'holder', 'camper', 'hider'];
  bots.forEach((p, i) => {
    applyRole(p.brain, pool[i]);
    if (team === 'D') p.brain.site = (i + (p.id % 2)) % 2 ? 'A' : 'B';
  });
}
// A peek crosses from an occluded tile to a nearby tile with a line to the same lane.
const peekCache = new Map();
function peekPair(site, team) {
  const key = site + team;
  if (peekCache.has(key)) return peekCache.get(key);
  const lane = LANES[site], center = team === 'T' ? lane.entry : lane.cover;
  const tiles = [];
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const p = [center[0] + dx, center[1] + dz];
    if (S.navBlocked(...p)) continue;
    const [x, z] = S.tileCenter(...p);
    tiles.push({ p, x, z, bias: Math.hypot(dx, dz) });
  }
  let pair = null;
  const approaches = team === 'T' ? [...S.HOLDS[site], lane.cover, lane.side] : [lane.entry, lane.side, lane.push];
  for (const aim of approaches) {
    const [tx, tz] = S.tileCenter(...aim);
    const hidden = [], visible = [];
    for (const q of tiles) (S.segClear([q.x, 1.55, q.z], [tx, 1.4, tz]) ? visible : hidden).push(q);
    let score = Infinity;
    for (const h of hidden) for (const e of visible) {
      if (Math.abs(h.p[0] - e.p[0]) + Math.abs(h.p[1] - e.p[1]) !== 1) continue;
      if (!S.segClear([h.x, 0.7, h.z], [e.x, 0.7, e.z])) continue;
      const val = 2 * h.bias + e.bias - Math.hypot(tx - h.x, tz - h.z) * 0.02;
      if (val < score) { score = val; pair = { cover: h.p, edge: e.p, x: tx, z: tz }; }
    }
    if (pair) break;
  }
  peekCache.set(key, pair);
  return pair;
}
function peekRoute(room, bot, site, go) {
  const b = bot.brain, t = now(), pair = peekPair(site, bot.team);
  if (!pair) return go(LANES[site].side);
  if (!b.peek || b.peek.pair !== pair) b.peek = { pair, stage: 'cover', until: 0, cycles: 0 };
  const s = b.peek;
  if (b.atGoal && b.goal?.[0] === s.pair[s.stage][0] && b.goal?.[1] === s.pair[s.stage][1]) {
    s.until ||= t + (s.stage === 'cover' ? rnd(0.8, 1.6) : rnd(0.7, 1.15));
    if (t >= s.until) {
      s.stage = s.stage === 'cover' ? 'edge' : 'cover';
      s.until = 0;
      if (s.stage === 'cover') s.cycles++;
    }
  }
  if (s.cycles >= 3 && s.stage === 'cover' && b.atGoal && b.goal?.join() === pair.cover.join()) {
    b.peek = null;
    b.peekReset = t + 5;
    return go(S.HOLDS[site][2]);
  }
  return go(pair[s.stage]);
}
function concealment(room, bot, threat) {
  const tx = Math.floor(bot.x / S.TILE), tz = Math.floor(bot.z / S.TILE);
  let goal = null, best = Infinity;
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    const d = Math.hypot(dx, dz), tile = [tx + dx, tz + dz];
    if (d < 1 || d > 4.4 || S.navBlocked(...tile)) continue;
    const [x, z] = S.tileCenter(...tile);
    if (inFire(room, x, z, 1) || S.segClear([x, 1.55, z], [threat.x, (threat.y || 0) + 1.35, threat.z])) continue;
    const path = S.findPath(tx, tz, ...tile, {});
    if (!path || path.length > 7) continue;
    const score = path.length - Math.hypot(x - threat.x, z - threat.z) * 0.065;
    if (score < best) { best = score; goal = tile; }
  }
  return goal;
}
function roleObjective(room, bot) {
  const b = bot.brain, t = now(), role = b.role;
  if (!role) return false;
  const bomb = room.bomb;
  const elapsed = S.ROUND.liveTime - room.timer;
  const attacking = bot.team === 'T', post = bomb.state === 'planted';
  const hot = room.hit && t - room.hit.t < 10 ? room.hit.site : null;
  const site = (post ? bomb.site : attacking ? room.targetSite : ['rusher', 'peeker'].includes(role) && hot ? hot : b.site) || b.site;
  const lane = LANES[site];
  const go = (tile) => { setGoal(room, bot, ...openTile(...tile)); return true; };
  const [wx, wz] = S.tileCenter(...(attacking && !post ? lane.cover : lane.watch));
  b.watch = { x: wx, z: wz };
  const entry = attacking && !post ? lane.entry : S.HOLDS[site][0];
  if (role === 'rusher') {
    const points = post ? [lane.watch, lane.side, S.HOLDS[site][3]]
      : attacking ? [S.HOLDS[site][3], lane.side, S.HOLDS[site][1]]
        : [elapsed < 21 ? lane.push : lane.entry, lane.side, lane.watch];
    if (b.atGoal && b.holdT?.repo <= t) b.pushIndex = ((b.pushIndex || 0) + 1) % points.length;
    return go(points[b.pushIndex || 0]);
  }
  if (role === 'peeker' && !post && !(b.peekReset > t)) return peekRoute(room, bot, site, go);
  if (role === 'peeker') return go(post ? lane.side : S.HOLDS[site][2]);
  if (role === 'hider' && b.retreat?.until > t) return go(b.retreat.tile);
  if (role === 'hider' && post && bomb.timer < 12) return go(lane.cover);
  const options = role === 'holder' ? [entry, attacking && !post ? lane.side : S.HOLDS[site][2]]
    : role === 'camper' ? [attacking && !post && elapsed < 25 ? lane.side : lane.cover, S.HOLDS[site][4]]
      : [attacking && !post && elapsed < 30 ? lane.side : lane.back, S.HOLDS[site][0]];
  if (role === 'hider' && b.leaveCover) {
    const next = openTile(...options[b.angleIndex || 0]);
    if (next.join() === b.leaveCover.join()) b.angleIndex = 1 - (b.angleIndex || 0);
    b.leaveCover = null; b.holdT = null;
  }
  if (b.atGoal && b.holdT?.repo <= t) b.angleIndex = 1 - (b.angleIndex || 0);
  return go(options[b.angleIndex || 0]);
}

// Human-like reaction windows (seconds) per difficulty, before the bot starts moving its crosshair.
const REACT = { easy: [0.5, 0.85], normal: [0.3, 0.5], hard: [0.17, 0.3], elite: [0.12, 0.21] };
// Watch angles from a tile: for each likely enemy approach, the farthest point of the route still in
// view — i.e. the corner an enemy would appear from. Cached since the map is static.
const angleCache = new Map();
function holdAngles(tx, tz, team) {
  const key = tx + ',' + tz + team;
  if (angleCache.has(key)) return angleCache.get(key);
  const [cx, cz] = S.tileCenter(tx, tz), out = [];
  const enemy = S.SPAWNS[team === 'D' ? 'T' : 'D'][2];
  const targets = [enemy, [22, 20], [7, 5], [36, 5]];
  for (const g of targets) {
    const path = S.findPath(tx, tz, g[0], g[1]);
    if (!path || path.length < 3) continue;
    let last = null;
    for (let i = 1; i < path.length; i++) {
      const [px, pz] = S.tileCenter(...path[i]);
      if (!S.losClear(cx, cz, px, pz)) break;
      last = [px, pz];
    }
    if (!last || Math.hypot(last[0] - cx, last[1] - cz) < 3) continue;
    const yaw = Math.atan2(last[0] - cx, last[1] - cz);
    if (!out.some((a) => Math.abs(angDiff(a, yaw)) < 0.35)) out.push(yaw);
  }
  if (!out.length) out.push(Math.atan2(S.tileCenter(...enemy)[0] - cx, S.tileCenter(...enemy)[1] - cz));
  angleCache.set(key, out);
  return out;
}
function turnToward(bot, yaw, dt, k, maxRate) {
  let dy = angDiff(bot.yaw, yaw) * (1 - Math.exp(-k * dt));
  if (maxRate) dy = Math.max(-maxRate * dt, Math.min(maxRate * dt, dy));
  bot.yaw += dy;
}
// run from a live frag the bot has noticed (better bots notice more often)
function fleeFrag(room, bot, dt, w) {
  const b = bot.brain;
  for (const n of room.nades) {
    if (n.k !== 'frag' || n.t < 0.25) continue;
    const d = Math.hypot(n.x - bot.x, n.z - bot.z);
    if (d > 5.5 || Math.abs(n.y - bot.y) > 3 || !S.losClear(bot.x, bot.z, n.x, n.z)) continue;
    b.noticed = b.noticed || {};
    if (b.noticed[n.id] == null) b.noticed[n.id] = Math.random() < 0.4 + 0.28 * bot.skill;
    if (!b.noticed[n.id]) continue;
    const yaw = d > 0.2 ? Math.atan2(bot.x - n.x, bot.z - n.z) : bot.yaw + Math.PI;
    const sp = w.speed * (b.exhausted ? 1 : S.SPRINT_MUL) * dt;
    if (botMove(bot, Math.sin(yaw) * sp, Math.cos(yaw) * sp) < sp * 0.3) botMove(bot, Math.cos(yaw) * sp, -Math.sin(yaw) * sp);
    bot.sprint = !b.exhausted; bot.crouch = false; b.path = null; b.goal = null; b.planAt = 0;
    if (bot.using) { bot.using = false; bot.useProg = 0; }
    return true;
  }
  return false;
}
function updateBot(room, bot, dt) {
  const b = bot.brain, t = now();
  const w = S.WEAPONS[bot.cur === 'primary' && bot.primary ? bot.primary : bot.secondary];
  const wKey = bot.cur === 'primary' && bot.primary ? bot.primary : bot.secondary;
  const sniper = w.rpm < 120 && !w.pellets;
  if (b.wasSprinting) b.readyAt = Math.max(b.readyAt || 0, t + 0.14);
  // perception
  if (t >= b.think) {
    b.think = t + rnd(0.10, 0.16);
    const seen = botSee(room, bot);
    if (seen) b.mem = { id: seen.id, x: seen.x, y: seen.y, z: seen.z, until: t + rnd(2.5, 3.5), fragged: b.mem?.id === seen.id ? b.mem.fragged : false };
    if (seen && (!b.target || b.target.id !== seen.id)) {
      const d = Math.hypot(seen.x - bot.x, seen.z - bot.z), yawTo = Math.atan2(seen.x - bot.x, seen.z - bot.z);
      const off = Math.abs(angDiff(bot.yaw, yawTo));
      // pre-aimed: the enemy showed up right where we were already looking (held angle / last-seen spot)
      const pre = off < 0.3;
      const [lo, hi] = REACT[room.diffKey] || REACT.normal;
      b.perceiveAt = t + Math.max(0.16, rnd(lo, hi) * (pre ? 0.65 : 1) + Math.min(off, 2.2) * 0.05 / Math.sqrt(bot.skill) + d * 0.002 + (seen.moving && !pre ? 0.04 : 0));
      // first flick over- or under-shoots in proportion to how far the crosshair has to travel
      const sgn = Math.sign(angDiff(bot.yaw, yawTo)) || 1;
      b.errY = (gauss() * 0.035 + sgn * Math.min(off, 2) * rnd(-0.1, 0.16)) / Math.pow(bot.skill, 1.5);
      b.errP = (gauss() * 0.03) / bot.skill;
      b.cs = null;
    }
    if (seen && t >= b.perceiveAt && t >= (b.radioAt || 0) && room.phase === 'live') {
      b.radioAt = t + rnd(0.65, 1.05);
      room.report(bot.team, `contact:${seen.id}`, { kind: 'contact', from: bot.id, x: seen.x, z: seen.z, until: t + 5 });
      if (bot.team === 'D') {
        const site = S.inSite(seen.x, seen.z);
        if (site) room.hit = { site, t };
      }
    }
    if (seen && t >= b.perceiveAt && t - bot.lastThrow > 4 && !bot.using) {
      const d = Math.hypot(seen.x - bot.x, seen.z - bot.z);
      const toss = d > 7 && d < 23 && bot.molly > 0 && seen.using ? 'molly'
        : d > 9 && d < 25 && Math.random() < 0.035 ? (bot.frag > 0 ? 'frag' : bot.flash > 0 && !room.team(bot.team).some((p) => p !== bot && p.alive && Math.hypot(p.x - seen.x, p.z - seen.z) < 8) ? 'flash' : null) : null;
      if (toss) { room.throwAt(bot, toss, seen.x, seen.z); b.readyAt = t + 0.42; }
    }
    // enemy ducked behind cover: frag where we last saw them
    if (!seen && b.mem && t < b.mem.until && !b.mem.fragged && bot.frag > 0 && t - bot.lastThrow > 2.5 && Math.random() < 0.12) {
      const d = Math.hypot(b.mem.x - bot.x, b.mem.z - bot.z);
      if (d > 8 && d < 25) { b.mem.fragged = true; room.throwAt(bot, 'frag', b.mem.x, b.mem.z); }
    }
    if (!bot.using && bot.adren > 0 && ((!seen && bot.hp <= 74) || (seen && bot.hp < 32 && t >= b.perceiveAt))) {
      room.useAdrenaline(bot); b.stamina = 1; b.exhausted = false; b.readyAt = t + 0.35;
    }
    // Store a sample, not a reference to an enemy's continually updated position.
    b.target = seen && { id: seen.id, x: seen.x, y: seen.y, z: seen.z, crouch: seen.crouch, yaw: seen.yaw, ln: seen.ln };
  }
  if (t < (b.blindUntil || 0)) b.target = null;
  if (b.mem && t > b.mem.until) b.mem = null;
  if (b.heard && t >= b.heard.until) b.heard = null;
  if (b.damageLook && t >= b.damageLook.until) b.damageLook = null;
  if (fleeFrag(room, bot, dt, w)) return;
  const fireHere = inFire(room, bot.x, bot.z, 0.4);
  if (fireHere && (fireHere.team !== bot.team || fireHere.owner === bot.id) && Math.abs(bot.y - fireHere.y) < 1.2) {
    const ex = bot.x - fireHere.x, ez = bot.z - fireHere.z, el = Math.hypot(ex, ez);
    const yaw = el > 0.2 ? Math.atan2(ex, ez) : bot.yaw + Math.PI;
    const sp = w.speed * 1.2 * dt;
    if (botMove(bot, Math.sin(yaw) * sp, Math.cos(yaw) * sp) < sp * 0.3) botMove(bot, Math.cos(yaw) * sp, -Math.sin(yaw) * sp);
    b.path = null; b.goal = null; b.planAt = 0;
    bot.using = false; bot.useProg = 0; bot.crouch = false;
    return;
  }
  const tgt = b.target && room.players.get(b.target.id)?.alive ? b.target : null;
  const mandatory = (room.bomb.state === 'carried' && room.bomb.carrier === bot.id) || (room.bomb.state === 'planted' && bot.team === 'D');
  const reaction = tgt && t >= b.perceiveAt;
  const nearby = tgt && Math.hypot(tgt.x - bot.x, tgt.z - bot.z);
  // Hiders break contact when threatened, then wait behind cover instead of firing from the open.
  const threat = reaction ? tgt : b.damageLook && b.heard?.kind === 'shot' ? b.heard : null;
  if (b.role === 'hider' && !mandatory && threat && (nearby < 19 || bot.hp < 72 || b.damageLook) &&
      t >= (b.nextRetreat || 0) && !b.retreat) {
    b.nextRetreat = t + 3;
    const tile = concealment(room, bot, threat);
    if (tile) { b.retreat = { tile, until: t + 6, settled: false }; b.invest = null; b.planAt = 0; }
  }
  if (b.retreat && !b.retreat.settled && b.atGoal && b.goal?.join() === b.retreat.tile.join()) {
    b.retreat.settled = true; b.retreat.until = t + rnd(3, 5);
  }
  if (b.retreat && b.retreat.until <= t) {
    if (b.retreat.settled) b.leaveCover = b.retreat.tile;
    b.retreat = null; b.nextRetreat = t + 1.5; b.planAt = 0;
  }
  if (b.role === 'peeker' && !mandatory && b.peek?.stage === 'edge' && reaction) {
    b.peek.until ||= t + 0.95;
    if (t >= b.peek.until) { b.peek.stage = 'cover'; b.peek.until = 0; b.peek.cycles++; b.planAt = 0; }
  }
  const withdraw = !mandatory && (b.role === 'hider' && !!b.retreat || b.role === 'peeker' && b.peek?.stage === 'cover');
  if (reaction && !withdraw) {
    // combat
    b.holdT = null;
    const tH = tgt.crouch ? S.PLAYER_H_CROUCH : S.PLAYER_H;
    if (b.aimHeadFor !== tgt.id || t > (b.aimHeadUntil || 0)) { b.aimHeadFor = tgt.id; b.aimHeadUntil = t + rnd(0.6, 1.4); b.aimHead = Math.random() < room.diff.head; }
    const aimHead = b.seePart === 'head' || b.aimHead;
    const aimY = aimHead ? tH - 0.18 : tH * 0.66;
    const [tlx, tlz] = S.leanOff(tgt.yaw || 0, tgt.ln || 0), lf = aimHead ? 1 : 0.6;
    const dx = tgt.x + tlx * lf - bot.x, dz = tgt.z + tlz * lf - bot.z, dh = Math.hypot(dx, dz);
    if (b.crouchUntil == null || t > b.crouchUntil + 1.2) b.crouchUntil = t + (dh > 12 && Math.random() < 0.2 + 0.12 * bot.skill ? rnd(0.8, 2) : 0);
    bot.sprint = false;
    const yawTo = Math.atan2(dx, dz), pitchTo = Math.atan2(tgt.y + aimY - (bot.y + S.eyeH(bot.crouch)), dh);
    // smooth crosshair travel toward a slightly-wrong point that converges as the bot settles
    const k = 6 + 4 * bot.skill;
    turnToward(bot, yawTo + b.errY, dt, k, 4 + 3.5 * bot.skill);
    bot.pitch += (pitchTo + b.errP - bot.pitch) * (1 - Math.exp(-k * dt));
    const dec = Math.exp(-(2 + 1.5 * bot.skill) * dt); b.errY *= dec; b.errP *= dec;
    if (bot.using && room.bomb.state === 'planted' && bot.useProg >= Math.max(0.6, room.bomb.timer - 1.4)) return;
    if (bot.using) { bot.using = false; bot.useProg = 0; }
    // counter-strafe: short strafe, full stop, shoot while planted, repeat
    if (!b.cs || t > b.cs.until) {
      const moving = b.cs ? !b.cs.move : false;
      const wantMove = moving && dh > 4 && !sniper && !w.pellets && Math.random() < (b.role === 'camper' || b.role === 'holder' ? 0.12 : 0.50) + 0.12 * bot.skill;
      b.cs = wantMove ? { move: true, dir: Math.random() < 0.5 ? -1 : 1, until: t + rnd(0.2, 0.45) / Math.sqrt(bot.skill) } : { move: false, until: t + rnd(0.3, 0.7) / Math.min(1.4, bot.skill) };
    }
    bot.crouch = !b.cs.move && (b.role === 'camper' || t < b.crouchUntil);
    if (b.role === 'rusher' && dh > 6.5) {
      const sp = w.speed * 0.82 * dt * (bot.adrenUntil > t ? S.ADREN_MUL : 1);
      if (botMove(bot, dx / dh * sp, dz / dh * sp) < sp * 0.25 && b.cs.move) botMove(bot, dz / dh * sp * b.cs.dir, -dx / dh * sp * b.cs.dir);
    } else if (b.cs.move) {
      const sp = w.speed * 0.62 * dt * (bot.adrenUntil > t ? S.ADREN_MUL : 1);
      if (botMove(bot, Math.cos(bot.yaw) * sp * b.cs.dir, -Math.sin(bot.yaw) * sp * b.cs.dir) < sp * 0.2) b.cs.dir *= -1;
    } else if (w.pellets && dh > 7) {
      const sp = w.speed * 0.8 * dt;
      botMove(bot, (dx / dh) * sp, (dz / dh) * sp);
    }
    const off = Math.abs(angDiff(bot.yaw, yawTo)), tol = Math.min(0.1, Math.atan2(0.3, dh) + 0.012 / bot.skill);
    const canShoot = !b.cs.move || bot.skill < 0.8 || w.pellets;
    if (canShoot && off < tol && Math.abs(bot.pitch - pitchTo) < tol * 1.4 && t - bot.lastShot >= 60 / w.rpm * (w.auto ? 1.15 : 1.6) && t >= Math.max(b.burstPause || 0, b.readyAt || 0)) {
      bot.lastShot = t;
      const sigma = (0.012 + (bot.moving ? 0.02 : 0) + (!bot.onGround ? 0.05 : 0) + (w.auto && b.burst > 4 ? 0.018 : 0) + (w.pellets ? 0 : w.spread)) / bot.skill * (bot.crouch ? 0.8 : 1);
      const yaw = bot.yaw + gauss() * sigma, pitch = bot.pitch + gauss() * sigma * 0.7;
      if (w.pellets) {
        const dirs = [];
        for (let i = 0; i < w.pellets; i++) { const py = yaw + gauss() * w.spread * 0.6, pp = pitch + gauss() * w.spread * 0.6; dirs.push([Math.sin(py) * Math.cos(pp), Math.sin(pp), Math.cos(py) * Math.cos(pp)]); }
        room.fire(bot, eyeOf(bot), dirs, wKey);
      } else room.fire(bot, eyeOf(bot), [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)], wKey);
      b.burst = (b.burst || 0) + 1;
      if (b.burst > 6 + Math.random() * 6) { b.burst = 0; b.burstPause = t + rnd(0.2, 0.45); }
    }
    return;
  }
  b.burst = 0;
  bot.crouch = false;
  if (tgt && !bot.using && !withdraw) return; // finite reaction time, no snap firing
  // attackers burn a defender angle on the way into the site
  if (bot.team === 'T' && bot.molly > 0 && room.phase === 'live' && !b.mollied && room.bomb.state !== 'planted' && Math.random() < 0.02) {
    const st = S.SITES[room.targetSite];
    const [cx, cz] = S.tileCenter((st.x0 + st.x1) / 2, (st.z0 + st.z1) / 2);
    const dSite = Math.hypot(cx - bot.x, cz - bot.z);
    if (dSite < 22 && dSite > 9) {
      b.mollied = true;
      if (Math.random() < 0.45) { const [hx, hz] = S.tileCenter(...pick(S.HOLDS[room.targetSite])); room.throwAt(bot, 'molly', hx, hz); }
    }
  }
  // attackers smoke off defender angles on the way into the site (a second smoke goes on another angle)
  if (bot.team === 'T' && bot.smoke > 0 && room.phase === 'live' && (b.smoked || 0) < 2 && t > (b.nextSmoke || 0) && room.bomb.state !== 'planted') {
    const st = S.SITES[room.targetSite];
    const [cx, cz] = S.tileCenter((st.x0 + st.x1) / 2, (st.z0 + st.z1) / 2);
    const dSite = Math.hypot(cx - bot.x, cz - bot.z);
    if (dSite < 24 && dSite > 8) {
      b.smoked = (b.smoked || 0) + 1; b.nextSmoke = t + rnd(1.2, 2.5);
      const [hx, hz] = S.tileCenter(...pick(S.HOLDS[room.targetSite]));
      room.throwAt(bot, 'smoke', hx * 0.75 + bot.x * 0.25, hz * 0.75 + bot.z * 0.25);
    }
  }
  // support attackers flash the site just before the team goes in
  if (b.role === 'peeker' && bot.team === 'T' && bot.flash > 0 && room.phase === 'live' && !b.supFlash && room.bomb.state !== 'planted') {
    const st = S.SITES[room.targetSite], [cx, cz] = S.tileCenter((st.x0 + st.x1) / 2, (st.z0 + st.z1) / 2), dSite = Math.hypot(cx - bot.x, cz - bot.z);
    if (dSite < 22 && dSite > 8 && Math.random() < 0.03) { b.supFlash = true; room.throwAt(bot, 'flash', ...S.tileCenter(...pick(S.HOLDS[room.targetSite]))); }
  }
  // objective actions
  const bomb = room.bomb;
  const carry = bot.team === 'T' && bomb.state === 'carried' && bomb.carrier === bot.id;
  const defuse = bot.team === 'D' && bomb.state === 'planted';
  if (room.phase === 'live' && bot.onGround && ((carry && bot.y < 0.3 && S.inSite(bot.x, bot.z) && (b.atGoal || room.timer < 14 || bot.using)) ||
    (defuse && Math.abs(bot.y - (bomb.y || 0)) < 1 && Math.hypot(bot.x - bomb.x, bot.z - bomb.z) < 1.6 &&
      !room.team('D').some((p) => p !== bot && p.alive && p.using && p.useProg > 0)))) {
    if (!bot.using) { bot.using = true; bot.useX = bot.x; bot.useZ = bot.z; }
    bot.crouch = true;
    return;
  }
  if (bot.using) { bot.using = false; bot.useProg = 0; }
  if (t >= b.planAt || b.bombState !== bomb.state) {
    b.planAt = t + rnd(0.2, 0.32);
    b.bombState = bomb.state;
    planObjective(room, bot);
  }
  if (!b.path && b.goal && t >= b.retryAt) setGoal(room, bot, ...b.goal, true);
  const peekLook = b.role === 'peeker' && b.peek?.stage === 'edge' ? b.peek.pair : null;
  const look = (b.role === 'hider' && b.retreat ? null : b.mem || b.heard) || (b.invest?.until > t ? b.invest : null) || peekLook || (b.warning?.until > t + 5.8 ? b.warning : null);
  const ld = look ? Math.hypot(look.x - bot.x, look.z - bot.z) : Infinity;
  const lookYaw = b.damageLook?.yaw ?? (look && ld > 0.7 && ld < 32 ? Math.atan2(look.x - bot.x, look.z - bot.z) : null);
  const lookPitch = b.mem ? Math.atan2(b.mem.y + 1.1 - (bot.y + S.eyeH(false)), Math.max(1, ld)) : 0;
  if (!b.path || b.pi >= b.path.length) {
    b.atGoal = !!b.path;
    if (b.atGoal && bot.onGround && (defuse || (bot.team === 'T' && bomb.state === 'dropped')) &&
        b.goal[0] === Math.floor(bomb.x / S.TILE) && b.goal[1] === Math.floor(bomb.z / S.TILE)) {
      const dx = bomb.x - bot.x, dz = bomb.z - bot.z, d = Math.hypot(dx, dz);
      if (d > 0.6) {
        const sp = Math.min(d, w.speed * dt);
        botMove(bot, dx / d * sp, dz / d * sp);
        return;
      }
    }
    const watch = b.watch && Math.atan2(b.watch.x - bot.x, b.watch.z - bot.z);
    holdPosition(room, bot, dt, lookYaw ?? (b.role === 'camper' ? watch : null), b.role === 'holder' ? watch : null);
    return;
  }
  b.atGoal = false; b.holdT = null;
  const next = b.path[b.pi], prev = b.path[b.pi - 1];
  const [nx, nz] = S.tileCenter(...next);
  const dx = nx - bot.x, dz = nz - bot.z, d = Math.hypot(dx, dz);
  if (d < 0.16) { b.pi++; b.progress = null; return; }
  const urgent = (defuse && bomb.timer < 14) || (carry && room.timer < 18);
  const hazard = inFire(room, nx, nz, 0.55);
  if (!urgent && hazard && Math.abs(bot.y - hazard.y) < 1.2 && (hazard.team !== bot.team || hazard.owner === bot.id) && prev && t >= (b.fireReroute || 0)) {
    b.fireReroute = t + 1;
    reroute(room, bot, prev, next, Math.min(2, hazard.t));
    return;
  }
  const left = b.path.length - b.pi;
  const moveYaw = Math.atan2(dx, dz);
  const cautious = !urgent && ld < 16 && next[2] == null && !b.aggr && !withdraw;
  const faceYaw = lookYaw ?? moveYaw;
  const sideways = Math.abs(angDiff(faceYaw, moveYaw)) > 0.72;
  turnToward(bot, faceYaw, dt, look ? 6 : 5, 4 + 2 * bot.skill);
  bot.pitch += (lookPitch - bot.pitch) * Math.min(1, 4 * dt);
  // If the next link goes up, time the jump along the approach to it.
  const jump = next[2] != null && S.propTop(nx, nz) > bot.y + S.STEP;
  if (jump && bot.onGround && prev && d <= S.TILE * (1 - next[2]) + 0.12 && t >= (b.jumpAt || 0)) {
    bot.vy = S.JUMP_V; bot.onGround = false; b.jumpAt = t + 0.46;
  }
  if (cautious && !b.aggr && d < 0.9 && b.pauseAt !== b.pi && prev && b.path[b.pi + 1]) {
    const nextNext = b.path[b.pi + 1];
    if (Math.abs(angDiff(Math.atan2(next[0] - prev[0], next[1] - prev[1]), Math.atan2(nextNext[0] - next[0], nextNext[1] - next[1]))) > 0.7) {
      b.pauseAt = b.pi; b.pauseUntil = t + rnd(0.16, 0.34); b.progress = null;
    }
  }
  if (t < b.pauseUntil) {
    bot.crouch = true;
    return;
  }
  const quietStep = !mandatory && !jump && (b.role === 'hider' && !b.retreat && left < 6 || b.role === 'camper' && left < 4 || b.role === 'peeker' && b.peek?.stage === 'cover' && left < 3);
  bot.crouch = bot.onGround && (quietStep || cautious && (ld < 8 || (!!b.invest && left < 4)));
  const sprintingRole = b.role === 'rusher' || !!b.retreat || mandatory || urgent;
  bot.sprint = room.phase === 'live' && !b.exhausted && !bot.crouch && !jump && !sideways && !cautious &&
    (sprintingRole || left > 13) && left > (sprintingRole ? 1 : 5) && Math.abs(angDiff(bot.yaw, moveYaw)) < 0.65;
  const mul = (bot.sprint ? S.SPRINT_MUL : bot.crouch ? S.CROUCH_MUL : cautious ? 0.82 : 1) * (bot.adrenUntil > t ? S.ADREN_MUL : 1);
  const sp = Math.min(d, w.speed * mul * dt);
  botMove(bot, dx / d * sp, dz / d * sp);
  const remaining = Math.hypot(nx - bot.x, nz - bot.z);
  if (!b.progress || remaining < b.progress.distance - 0.12) b.progress = { distance: remaining, t };
  else if (t - b.progress.t > 0.9) reroute(room, bot, prev, next, 3.5);
}
function reroute(room, bot, prev, next, delay) {
  const b = bot.brain;
  if (prev) b.blocked.set(S.navEdgeKey(prev[1] * S.W + prev[0], next[1] * S.W + next[0]), now() + delay);
  setGoal(room, bot, ...b.goal, true);
  // If we were approaching a corner off-center, recenter before trying the detour.
  if (b.path && b.path.length > 1) {
    const [x, z] = S.tileCenter(...b.path[0]);
    if (!S.collides(x, z, S.PLAYER_R, bot.y) && Math.hypot(x - bot.x, z - bot.z) > 0.4) b.pi = 0;
  }
}
// at a hold spot: watch the corners enemies come from, swap between angles, jiggle, sometimes crouch,
// and occasionally reposition to a different spot so the hold isn't predictable
function holdPosition(room, bot, dt, memYaw, preferredYaw = null) {
  const b = bot.brain, t = now();
  const tx = Math.floor(bot.x / S.TILE), tz = Math.floor(bot.z / S.TILE);
  if (!b.holdT || b.holdT.key !== tx + ',' + tz) {
    const holdFor = { rusher: [0.7, 1.6], holder: [6, 9], peeker: [1, 2], camper: [11, 16], hider: [7, 11] }[b.role] || [2, 4];
    const angles = holdAngles(tx, tz, bot.team);
    const preferred = preferredYaw == null ? -1 : angles.findIndex((a) => Math.abs(angDiff(a, preferredYaw)) < 0.35);
    b.holdT = { key: tx + ',' + tz, angles: preferredYaw != null && preferred === -1 ? [preferredYaw, ...angles] : angles,
      idx: preferredYaw != null ? Math.max(0, preferred) : (Math.random() * angles.length) | 0,
      until: t + rnd(0.9, 2.1), repo: t + rnd(...holdFor) };
    b.holdCrouch = Math.random() < 0.25;
  }
  const h = b.holdT;
  if (t > h.until) {
    if (h.angles.length > 1) h.idx = (h.idx + 1 + ((Math.random() * (h.angles.length - 1)) | 0)) % h.angles.length;
    h.until = t + rnd(1.2, 2.6); h.jig = rnd(-0.12, 0.12);
    if (Math.random() < 0.2) b.holdCrouch = !b.holdCrouch;
  }
  const yaw = memYaw ?? h.angles[h.idx] + (h.jig || 0) + Math.sin(t * 1.3 + bot.id) * 0.035;
  turnToward(bot, yaw, dt, 3.5 + bot.skill, 2.5 + 1.5 * bot.skill);
  bot.pitch += (-0.02 - bot.pitch) * Math.min(1, 3 * dt);
  bot.crouch = room.phase === 'live' && (b.role === 'camper' || b.role === 'hider' || (b.role === 'peeker' && b.peek?.stage === 'cover') || (!!b.holdCrouch && !['rusher', 'holder'].includes(b.role)));
  // small side-steps, like a player adjusting an off-angle
  if (b.role !== 'camper' && b.role !== 'hider' && Math.random() < 0.004) h.step = { dir: Math.random() < 0.5 ? -1 : 1, until: t + rnd(0.2, 0.45) };
  if (h.step && t < h.step.until) {
    const sp = 2.2 * dt, dx = Math.cos(bot.yaw) * sp * h.step.dir, dz = -Math.sin(bot.yaw) * sp * h.step.dir;
    if (Math.floor((bot.x + dx) / S.TILE) === tx && Math.floor((bot.z + dz) / S.TILE) === tz) botMove(bot, dx, dz);
    else h.step = null;
  }
}
function planInvestigation(room, bot) {
  const b = bot.brain, t = now();
  let best = null, score = 0;
  b.warning = null;
  b.handled ||= new Map();
  for (const [key, until] of b.handled) if (until <= t) b.handled.delete(key);
  for (const info of room.intel[bot.team].values()) {
    if (info.until <= t) continue;
    const d = Math.hypot(info.x - bot.x, info.z - bot.z);
    if (info.kind === 'loss' && d < 19 && (!b.warning || b.warning.until < info.until)) b.warning = info;
    if (info.assigned !== bot.id || b.handled.has(info.key)) continue;
    const value = (info.kind === 'loss' ? 40 : 27) - d * 0.55;
    if (value > score) { score = value; best = info; }
  }
  if (b.invest && (b.invest.until <= t || (b.atGoal && b.holdT && t > b.holdT.until - 0.2))) b.invest = null;
  if (b.invest) { setGoal(room, bot, ...b.invest.tile); return true; }
  const dHeard = b.heard && Math.hypot(b.heard.x - bot.x, b.heard.z - bot.z);
  const soundRange = { rusher: 24, peeker: 16, holder: 10, camper: 6, hider: 4 }[b.role] ?? 12;
  if (!best && b.heard && b.heard.sample > (b.lastInvestigated || 0) + 0.9 && dHeard < soundRange) best = b.heard;
  if (!best) return false;
  const tile = openTile(Math.floor(best.x / S.TILE), Math.floor(best.z / S.TILE));
  const lifetime = best.key ? Math.min(best.until, t + 5) : Math.min(best.until + 0.8, t + 3.3);
  if (best.key) b.handled.set(best.key, t + 7);
  else b.lastInvestigated = t;
  b.invest = { ...best, tile, until: lifetime };
  setGoal(room, bot, ...tile);
  return true;
}
function patrolTile(room, bot, site, elevatedOnly = false) {
  const b = bot.brain, tx = Math.floor(bot.x / S.TILE), tz = Math.floor(bot.z / S.TILE);
  const candidates = [], elevated = [];
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
    if (Math.hypot(dx, dz) < 2 || Math.hypot(dx, dz) > 4.5) continue;
    const x = tx + dx, z = tz + dz, [cx, cz] = S.tileCenter(x, z);
    if (S.solidAt(x, z) || (site && S.inSite(cx, cz) !== site) || (b.lastPatrol?.[0] === x && b.lastPatrol?.[1] === z)) continue;
    if (inFire(room, cx, cz, 0.4) || !S.losClear(bot.x, bot.z, cx, cz)) continue;
    if (room.bomb.state === 'planted' && Math.hypot(cx - room.bomb.x, cz - room.bomb.z) > 15) continue;
    if (!S.navBlocked(x, z)) candidates.push([x, z]);
    else if (S.propTop(cx, cz) === 0.95 && !S.collides(cx, cz, S.PLAYER_R, 0.95)) elevated.push([x, z]);
  }
  if (elevatedOnly) return pick(elevated);
  return elevated.length && Math.random() < 0.28 ? pick(elevated) : pick(candidates);
}
function planObjective(room, bot) {
  const b = bot.brain, bomb = room.bomb, t = now();
  const bombTile = [Math.floor(bomb.x / S.TILE), Math.floor(bomb.z / S.TILE)];
  const go = (tile) => setGoal(room, bot, ...tile);
  const nearest = (team) => room.bots(team).filter((p) => p.alive)
    .sort((a, c) => Math.hypot(a.x - bomb.x, a.z - bomb.z) - Math.hypot(c.x - bomb.x, c.z - bomb.z))[0];
  if (bot.team === 'T' && bomb.state === 'carried' && bomb.carrier === bot.id) {
    b.invest = b.patrol = null;
    return go(b.plantTile ||= randSiteTile(room.targetSite));
  }
  if (bot.team === 'T' && bomb.state === 'dropped' && nearest('T') === bot) {
    b.invest = b.patrol = null;
    return go(bombTile);
  }
  if (bot.team === 'D' && bomb.state === 'planted') {
    b.invest = b.patrol = null;
    const existing = room.playerDefuser;
    if (!existing?.alive || !existing.isBot || existing.team !== 'D') room.playerDefuser = nearest('D');
    return go(room.playerDefuser === bot || bomb.timer < 12 ? bombTile : (b.retake ||= nearTile(bomb.x, bomb.z, 3)));
  }
  if (b.role === 'hider' && b.retreat) return go(b.retreat.tile);
  if (b.role === 'peeker' && b.peek?.stage === 'cover' && (!b.atGoal || b.goal?.join() !== b.peek.pair.cover.join())) return go(b.peek.pair.cover);
  if (bomb.state !== 'planted' && room.phase === 'live' && planInvestigation(room, bot)) { b.patrol = null; return; }
  if (b.patrol && (!b.atGoal || t < (b.holdT?.repo ?? Infinity)) && t < b.patrol.until) return go(b.patrol.tile);
  if (b.role && ['holder', 'camper'].includes(b.role) && b.atGoal && b.holdT?.repo <= t && !b.patrol && !b.tookPerch && Math.random() < 0.35) {
    const perch = patrolTile(room, bot, null, true);
    if (perch) { b.tookPerch = true; b.lastPatrol = perch; b.patrol = { tile: perch, until: t + 8 }; return go(perch); }
  }
  if (roleObjective(room, bot)) return;
  if ((b.holdT && t > b.holdT.repo) || (b.patrol && t >= b.patrol.until)) {
    b.patrol = null;
    const site = bomb.state === 'planted' ? bomb.site : null;
    const tile = patrolTile(room, bot, site) || patrolTile(room, bot, null);
    if (tile) {
      b.lastPatrol = tile;
      b.patrol = { tile, until: t + 9 };
      return go(tile);
    }
    b.holdT = null;
  }
  if (bomb.state === 'planted') return go(b.guard ||= nearTile(bomb.x, bomb.z, 5));
  if (bot.team === 'T' && bomb.state === 'dropped') return go(b.hold ||= randSiteTile(room.targetSite));
  if (bot.team === 'T') return go(b.hold ||= randSiteTile(room.targetSite));
  return go(b.hold ||= pick(S.HOLDS[b.site]));
}


// The server owns one clock and advances all its started rooms together.
export function stepRooms(rooms, dt) {
  simT += dt;
  for (const room of rooms) room.update(dt);
}

// ------------------------------------------------------------------ local "connection"
// Behaves like a WebSocket so the client code stays the same.
export function createLocalGame() {
  let room = null, player = null, paused = false, last = performance.now() / 1000;
  const queue = [];
  const deliver = (msg) => { queue.push(msg); if (queue.length === 1) queueMicrotask(flush); };
  function flush() { const q = queue.splice(0); for (const m of q) conn.onmessage?.({ data: m }); }
  const sock = { readyState: 1, local: true, send: (m) => deliver(typeof m === 'string' ? JSON.parse(m) : m) };
  const conn = {
    readyState: 1, onmessage: null, onopen: null, onclose: null,
    send(raw) {
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (m.t === 'join' && !player) {
        room = new Room('SOLO', m.difficulty);
        const name = String(m.name || 'Player').replace(/[<>]/g, '').slice(0, 14) || 'Player';
        player = room.addHuman(sock, name, m.team);
        deliver({ t: 'welcome', id: player.id, room: 'SOLO', team: player.team, difficulty: room.diffKey });
        room.sendSnap(true);
        return;
      }
      if (m.t === 'ping') { deliver({ t: 'pong', ts: m.ts }); return; }
      if (m.t === 'difficulty') { room?.setDifficulty(m.v); return; }
      if (room && player) room.onMessage(player, m);
    },
    close() { clearInterval(timer); conn.readyState = 3; },
    setPaused(v) { paused = !!v; last = performance.now() / 1000; },
    get paused() { return paused; },
    get room() { return room; },
    step(dt) { simT += dt; room?.update(dt); }, // test hook
  };
  const timer = setInterval(() => {
    const t = performance.now() / 1000;
    const dt = Math.min(t - last, 0.1); last = t;
    if (paused || !room) return;
    simT += dt;
    try { room.update(dt); } catch (e) { console.error(e); }
  }, TICK * 1000);
  queueMicrotask(() => conn.onopen?.());
  return conn;
}
