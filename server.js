const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/game-stream' });

const FIELD_W = 1800;
const FIELD_H = 1100;
const GOAL_H = 220;
const PLAYER_R = 20;
const BALL_R = 11;
const MATCH_DURATION = 180;

const TEAM_CATALOG = [
  { code: 'KOR', name: '대한민국 국대', grade: 'SILVER', baseStat: 76, price: 800, color1: '#dc2626', color2: '#1d4ed8', shorts: '#0f172a', roster: ['손흥민', '이강인', '김민재', '조현우'], numbers: [7, 18, 4, 21] },
  { code: 'TOT', name: '토트넘 홋스퍼', grade: 'SILVER', baseStat: 78, price: 1100, color1: '#f8fafc', color2: '#1e3a8a', shorts: '#1e3a8a', roster: ['손흥민', '매디슨', '반더벤', '비카리오'], numbers: [7, 10, 37, 1] },
  { code: 'PSG', name: '파리 생제르맹', grade: 'GOLD', baseStat: 83, price: 2000, color1: '#1e3a8a', color2: '#dc2626', shorts: '#1e3a8a', roster: ['뎀벨레', '이강인', '마르퀴뇨스', '돈나룸마'], numbers: [10, 19, 5, 99] },
  { code: 'BAY', name: '바이에른 뮌헨', grade: 'GOLD', baseStat: 85, price: 2400, color1: '#dc2626', color2: '#ffffff', shorts: '#dc2626', roster: ['해리 케인', '무시알라', '김민재', '노이어'], numbers: [9, 42, 3, 1] },
  { code: 'ARS', name: '아스날 FC', grade: 'GOLD', baseStat: 84, price: 2200, color1: '#ef4444', color2: '#ffffff', shorts: '#ffffff', roster: ['사카', '외데고르', '살리바', '라야'], numbers: [7, 8, 2, 22] },
  { code: 'BAR', name: 'FC 바르셀로나', grade: 'GOLD', baseStat: 86, price: 2800, color1: '#1d4ed8', color2: '#b91c1c', shorts: '#1e3a8a', roster: ['야말', '페드리', '아라우호', '테어슈테겐'], numbers: [19, 8, 4, 1] },
  { code: 'MCI', name: '맨체스터 시티', grade: 'ICON', baseStat: 90, price: 4500, color1: '#38bdf8', color2: '#ffffff', shorts: '#ffffff', roster: ['홀란드', '더브라위너', '디아스', '에데르송'], numbers: [9, 17, 3, 31] },
  { code: 'RMA', name: '레알 마드리드', grade: 'ICON', baseStat: 91, price: 5000, color1: '#ffffff', color2: '#eab308', shorts: '#ffffff', roster: ['음바페', '벨링엄', '뤼디거', '쿠르투아'], numbers: [9, 5, 22, 1] }
];

let transferMarket = [
  { marketId: 'm1', seller: '런던 스카우터', team: { ...TEAM_CATALOG[1], level: 2 }, price: 1350 },
  { marketId: 'm2', seller: '뮌헨 구단주', team: { ...TEAM_CATALOG[3], level: 2 }, price: 2700 },
  { marketId: 'm3', seller: '갈락티코스', team: { ...TEAM_CATALOG[7], level: 1 }, price: 4900 }
];

const rooms = {};

function getOrCreateRoom(roomId) {
  const id = (roomId || 'quick_1').slice(0, 15);
  if (!rooms[id]) {
    rooms[id] = {
      id,
      users: {},
      entities: [],
      ball: { x: FIELD_W / 2, y: FIELD_H / 2, z: 0, vz: 0, vx: 0, vy: 0, ownerEid: null, lastTouchSide: 'red' },
      score: { red: 0, blue: 0 },
      timeLeft: MATCH_DURATION,
      goalCooldown: 0,
      bannerText: '',
      bannerTimer: 0,
      setPiece: null, // { type: 'THROW_IN'|'CORNER'|'GOAL_KICK'|'PENALTY'|'FREE_KICK', side, x, y, timer }
      matchEnded: false
    };
    initRoomEntities(rooms[id]);
  }
  return rooms[id];
}

function showBanner(room, text, frames = 80) {
  room.bannerText = text;
  room.bannerTimer = frames;
}

function initRoomEntities(room) {
  room.entities = [];
  const redUser = Object.values(room.users).find(u => u.teamSide === 'red');
  const blueUser = Object.values(room.users).find(u => u.teamSide === 'blue');

  const redTeamInfo = redUser ? redUser.activeTeam : { ...TEAM_CATALOG[0], level: 1 };
  const blueTeamInfo = blueUser ? blueUser.activeTeam : { ...TEAM_CATALOG[2], level: 1 };

  const formations = {
    red: [
      { role: 'ST', x: FIELD_W * 0.43, y: FIELD_H * 0.5 },
      { role: 'MF', x: FIELD_W * 0.31, y: FIELD_H * 0.30 },
      { role: 'DF', x: FIELD_W * 0.23, y: FIELD_H * 0.70 },
      { role: 'GK', x: 60, y: FIELD_H * 0.5 }
    ],
    blue: [
      { role: 'ST', x: FIELD_W * 0.57, y: FIELD_H * 0.5 },
      { role: 'MF', x: FIELD_W * 0.69, y: FIELD_H * 0.70 },
      { role: 'DF', x: FIELD_W * 0.77, y: FIELD_H * 0.30 },
      { role: 'GK', x: FIELD_W - 60, y: FIELD_H * 0.5 }
    ]
  };

  ['red', 'blue'].forEach(side => {
    const tInfo = side === 'red' ? redTeamInfo : blueTeamInfo;
    formations[side].forEach((pos, idx) => {
      room.entities.push({
        eid: `${side}_${idx}`,
        side,
        idx,
        role: pos.role,
        name: tInfo.roster[idx] || `선수${idx + 1}`,
        number: (tInfo.numbers && tInfo.numbers[idx]) || (idx + 7),
        teamName: tInfo.name,
        stat: tInfo.baseStat + (tInfo.level - 1) * 3,
        color1: tInfo.color1 || (side === 'red' ? '#ef4444' : '#3b82f6'),
        color2: tInfo.color2 || '#ffffff',
        shorts: tInfo.shorts || '#0f172a',
        x: pos.x,
        y: pos.y,
        homeX: pos.x,
        homeY: pos.y,
        vx: 0,
        vy: 0,
        facing: side === 'red' ? 0 : Math.PI,
        stamina: 100,
        charge: 0,
        chargeType: null,
        tackleTimer: 0,
        tackleCooldown: 0,
        stunTimer: 0,
        animFrame: 0,
        controllerUserId: null
      });
    });
  });

  assignControllers(room);
}

function assignControllers(room) {
  room.entities.forEach(e => { e.controllerUserId = null; });
  ['red', 'blue'].forEach(side => {
    const sideUsers = Object.values(room.users).filter(u => u.teamSide === side);
    const sideEntities = room.entities.filter(e => e.side === side);
    sideUsers.forEach((u, uIdx) => {
      if (u.controlledIdx == null || u.controlledIdx >= sideEntities.length) {
        u.controlledIdx = uIdx % sideEntities.length;
      }
      const target = sideEntities[u.controlledIdx];
      if (target) target.controllerUserId = u.id;
    });
  });
}

function resetPositions(room) {
  room.ball.x = FIELD_W / 2;
  room.ball.y = FIELD_H / 2;
  room.ball.z = 0;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.vz = 0;
  room.ball.ownerEid = null;
  room.setPiece = null;
  room.entities.forEach(e => {
    e.x = e.homeX;
    e.y = e.homeY;
    e.vx = 0;
    e.vy = 0;
    e.charge = 0;
    e.tackleTimer = 0;
    e.stunTimer = 0;
  });
}

// 세트피스(스로인, 코너킥, 골킥, 페널티킥, 프리킥) 세팅
function triggerSetPiece(room, type, side, x, y, label) {
  room.setPiece = { type, side, x, y, timer: 180 };
  room.ball.x = x;
  room.ball.y = y;
  room.ball.z = 0;
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.ball.vz = 0;
  room.ball.ownerEid = null;
  showBanner(room, label, 90);

  // 해당 팀 대표 키커를 공 위치로 이동
  const kicker = room.entities.find(e => e.side === side && e.role !== 'GK') || room.entities.find(e => e.side === side);
  if (kicker) {
    kicker.x = x + (side === 'red' ? -18 : 18);
    kicker.y = y;
    kicker.vx = 0;
    kicker.vy = 0;
    kicker.facing = side === 'red' ? 0 : Math.PI;
    room.ball.ownerEid = kicker.eid;

    // 유저가 있으면 키커로 자동 조작 전환
    const sideUser = Object.values(room.users).find(u => u.teamSide === side);
    if (sideUser) {
      sideUser.controlledIdx = kicker.idx;
      assignControllers(room);
    }
  }

  // 페널티킥(PK) 시 상대 골키퍼를 골라인 중앙에 배치
  if (type === 'PENALTY') {
    const defSide = side === 'red' ? 'blue' : 'red';
    const gk = room.entities.find(e => e.side === defSide && e.role === 'GK');
    if (gk) {
      gk.x = defSide === 'red' ? 45 : FIELD_W - 45;
      gk.y = FIELD_H / 2;
    }
  }
}

function switchClosestPlayer(room, user) {
  const sideEntities = room.entities.filter(e => e.side === user.teamSide);
  let bestIdx = 0;
  let minDist = Infinity;
  sideEntities.forEach((e, idx) => {
    if (idx === user.controlledIdx) return;
    if (e.controllerUserId && e.controllerUserId !== user.id) return;
    const d = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
    if (d < minDist) { minDist = d; bestIdx = idx; }
  });
  user.controlledIdx = bestIdx;
  assignControllers(room);
}

// 슛 / 패스 즉시 실행 함수 (키 뗄 때 + 최대 차징 시 확실히 발사)
function executeKick(room, e, kickType, powerRatio) {
  const statFactor = 1 + (e.stat - 75) * 0.007;
  room.ball.ownerEid = null;
  room.ball.lastTouchSide = e.side;
  room.setPiece = null;

  if (kickType === 'shoot') {
    const power = (14.5 + powerRatio * 13.5) * statFactor;
    room.ball.vx = Math.cos(e.facing) * power;
    room.ball.vy = Math.sin(e.facing) * power;
    room.ball.vz = 2.2 + powerRatio * 4.2;
  } else {
    const target = findPassTarget(room, e);
    if (target) {
      const leadX = kickType === 'through' ? (e.side === 'red' ? 120 : -120) : 0;
      const ang = Math.atan2(target.y - room.ball.y, (target.x + leadX) - room.ball.x);
      const pSpd = (14.5 + powerRatio * 6) * statFactor;
      room.ball.vx = Math.cos(ang) * pSpd;
      room.ball.vy = Math.sin(ang) * pSpd;
      room.ball.vz = kickType === 'through' ? 2.4 : 0.6;
    } else {
      room.ball.vx = Math.cos(e.facing) * 16;
      room.ball.vy = Math.sin(e.facing) * 16;
    }
  }
  e.charge = 0;
  e.chargeType = null;
}

function handleAction(userId, roomId, msg) {
  const room = getOrCreateRoom(roomId);
  if (!room.users[userId]) {
    const redUsers = Object.values(room.users).filter(u => u.teamSide === 'red').length;
    const blueUsers = Object.values(room.users).filter(u => u.teamSide === 'blue').length;
    room.users[userId] = {
      id: userId,
      name: msg.nickname || `감독_${userId.slice(0, 4)}`,
      teamSide: redUsers <= blueUsers ? 'red' : 'blue',
      controlledIdx: 0,
      lastSeen: Date.now(),
      input: { up: false, down: false, left: false, right: false, shoot: false, pass: false, through: false, sprint: false, tackle: false },
      activeTeam: msg.activeTeam || { ...TEAM_CATALOG[0], level: 1 }
    };
    initRoomEntities(room);
  }

  const user = room.users[userId];
  user.lastSeen = Date.now();

  if (msg.type === 'join' || msg.type === 'syncTeam') {
    if (msg.nickname) user.name = msg.nickname.slice(0, 10);
    if (msg.teamSide && (msg.teamSide === 'red' || msg.teamSide === 'blue')) user.teamSide = msg.teamSide;
    if (msg.activeTeam) user.activeTeam = msg.activeTeam;
    initRoomEntities(room);
  } else if (msg.type === 'input') {
    user.input = msg.input;
  } else if (msg.type === 'kickNow') {
    // 키를 떼는 순간 즉시 슛/패스 발사 (패킷 누락 원천 차단)
    const ent = room.entities.find(e => e.controllerUserId === userId);
    if (ent) {
      const dist = Math.hypot(room.ball.x - ent.x, room.ball.y - ent.y);
      if (room.ball.ownerEid === ent.eid || dist < PLAYER_R + BALL_R + 34) {
        executeKick(room, ent, msg.kickType || 'shoot', Math.max(0.35, ent.charge / 100));
      }
      ent.charge = 0;
      ent.chargeType = null;
    }
  } else if (msg.type === 'tackleNow') {
    const ent = room.entities.find(e => e.controllerUserId === userId);
    if (ent && ent.tackleCooldown === 0 && ent.stunTimer === 0) {
      ent.tackleTimer = 14;
      ent.tackleCooldown = 45;
      ent.vx = Math.cos(ent.facing) * 14;
      ent.vy = Math.sin(ent.facing) * 14;
    }
  } else if (msg.type === 'switchPlayer') {
    switchClosestPlayer(room, user);
  } else if (msg.type === 'restartMatch') {
    room.score = { red: 0, blue: 0 };
    room.timeLeft = MATCH_DURATION;
    room.matchEnded = false;
    initRoomEntities(room);
    resetPositions(room);
  }
}

app.get('/api/market', (req, res) => {
  res.json({ market: transferMarket, catalog: TEAM_CATALOG });
});

app.post('/api/market/list', (req, res) => {
  const { seller, team, price } = req.body;
  if (!team || !price || price < 100) return res.status(400).json({ error: '잘못된 등록 정보' });
  const item = {
    marketId: 'm_' + Date.now() + Math.random().toString(36).slice(2, 5),
    seller: seller || '구단주',
    team,
    price: Math.floor(Number(price))
  };
  transferMarket.unshift(item);
  res.json({ ok: true, market: transferMarket });
});

app.post('/api/market/buy', (req, res) => {
  const { marketId } = req.body;
  const idx = transferMarket.findIndex(m => m.marketId === marketId);
  if (idx === -1) return res.status(404).json({ error: '이미 판매된 팀입니다.' });
  const [bought] = transferMarket.splice(idx, 1);
  res.json({ ok: true, item: bought, market: transferMarket });
});

wss.on('connection', (ws) => {
  let boundUserId = null;
  let boundRoomId = 'quick_1';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      boundUserId = msg.userId || boundUserId;
      boundRoomId = msg.roomId || boundRoomId;
      if (boundUserId) handleAction(boundUserId, boundRoomId, msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    if (boundUserId && rooms[boundRoomId] && rooms[boundRoomId].users[boundUserId]) {
      delete rooms[boundRoomId].users[boundUserId];
      assignControllers(rooms[boundRoomId]);
    }
  });
});

app.post('/api/sync', (req, res) => {
  const { userId, roomId, messages } = req.body;
  if (!userId) return res.status(400).end();
  const rId = roomId || 'quick_1';
  if (Array.isArray(messages)) {
    messages.forEach(m => handleAction(userId, rId, m));
  } else {
    handleAction(userId, rId, { type: 'ping' });
  }
  const room = getOrCreateRoom(rId);
  res.json(serializeRoom(room));
});

function serializeRoom(room) {
  return {
    id: room.id,
    users: room.users,
    entities: room.entities,
    ball: room.ball,
    score: room.score,
    timeLeft: Math.ceil(room.timeLeft),
    goalCooldown: room.goalCooldown,
    bannerText: room.bannerTimer > 0 ? room.bannerText : '',
    setPiece: room.setPiece,
    matchEnded: room.matchEnded
  };
}

function updateEntityAI(room, e) {
  if (e.stunTimer > 0) return;
  const ball = room.ball;
  const isRed = e.side === 'red';
  const ownGoalX = isRed ? 55 : FIELD_W - 55;
  const targetGoalX = isRed ? FIELD_W : 0;

  if (e.role === 'GK') {
    const goalMinY = (FIELD_H - GOAL_H) / 2 + 16;
    const goalMaxY = (FIELD_H + GOAL_H) / 2 - 16;
    const desiredY = Math.max(goalMinY, Math.min(goalMaxY, ball.y));
    const distToBall = Math.hypot(ball.x - e.x, ball.y - e.y);
    const desiredX = distToBall < 150 ? ownGoalX + (isRed ? 50 : -50) : ownGoalX;

    const dx = desiredX - e.x;
    const dy = desiredY - e.y;
    e.vx += Math.sign(dx) * Math.min(Math.abs(dx) * 0.07, 0.55);
    e.vy += Math.sign(dy) * Math.min(Math.abs(dy) * 0.07, 0.55);

    if (distToBall < PLAYER_R + BALL_R + 12) {
      room.ball.ownerEid = null;
      room.ball.lastTouchSide = e.side;
      const clearAngle = Math.atan2((Math.random() - 0.5) * 350, targetGoalX - e.x);
      ball.vx = Math.cos(clearAngle) * 16;
      ball.vy = Math.sin(clearAngle) * 16;
      ball.vz = 4;
    }
    return;
  }

  // AI가 세트피스 키커일 경우 1.2초 후 자동 킥
  if (room.setPiece && room.setPiece.side === e.side && ball.ownerEid === e.eid) {
    if (room.setPiece.timer < 110) {
      e.facing = Math.atan2(FIELD_H / 2 - e.y, targetGoalX - e.x);
      executeKick(room, e, room.setPiece.type === 'PENALTY' ? 'shoot' : 'pass', 0.65);
    }
    return;
  }

  const teammates = room.entities.filter(t => t.side === e.side && t.role !== 'GK');
  let closestToBall = teammates[0];
  let minD = Infinity;
  teammates.forEach(t => {
    const d = Math.hypot(ball.x - t.x, ball.y - t.y);
    if (d < minD) { minD = d; closestToBall = t; }
  });

  if (ball.ownerEid === e.eid) {
    const distToGoal = Math.hypot(targetGoalX - e.x, FIELD_H / 2 - e.y);
    const angleToGoal = Math.atan2(FIELD_H / 2 - e.y, targetGoalX - e.x);
    e.vx += Math.cos(angleToGoal) * 0.50;
    e.vy += Math.sin(angleToGoal) * 0.50;

    if (distToGoal < 470 && Math.random() < 0.04) {
      e.facing = Math.atan2((FIELD_H / 2 + (Math.random() - 0.5) * 140) - ball.y, targetGoalX - ball.x);
      executeKick(room, e, 'shoot', 0.75);
    } else if (Math.random() < 0.018) {
      executeKick(room, e, 'pass', 0.6);
    }
    return;
  }

  let destX = e.homeX + (ball.x - FIELD_W / 2) * 0.42;
  let destY = e.homeY + (ball.y - FIELD_H / 2) * 0.35;

  if (closestToBall && closestToBall.eid === e.eid) {
    destX = ball.x;
    destY = ball.y;
  }

  const dx = destX - e.x;
  const dy = destY - e.y;
  const dist = Math.hypot(dx, dy);
  const aiAccel = 0.44 + (e.stat - 75) * 0.004;
  if (dist > 8) {
    e.vx += (dx / dist) * aiAccel;
    e.vy += (dy / dist) * aiAccel;
  }
}

function findPassTarget(room, passer) {
  const dirX = passer.side === 'red' ? 1 : -1;
  let best = null;
  let bestScore = -Infinity;
  room.entities.forEach(teammate => {
    if (teammate.side !== passer.side || teammate.eid === passer.eid) return;
    const dx = teammate.x - passer.x;
    const dy = teammate.y - passer.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 40 || dist > 950) return;
    const score = (dx * dirX * 0.65) - dist * 0.25;
    if (score > bestScore) { bestScore = score; best = teammate; }
  });
  return best;
}

setInterval(() => {
  const now = Date.now();
  Object.values(rooms).forEach(room => {
    let changed = false;
    Object.values(room.users).forEach(u => {
      if (now - u.lastSeen > 6000) { delete room.users[u.id]; changed = true; }
    });
    if (changed) assignControllers(room);

    if (room.bannerTimer > 0) room.bannerTimer--;
    if (room.matchEnded) { broadcastRoom(room); return; }

    if (room.goalCooldown > 0) {
      room.goalCooldown--;
      if (room.goalCooldown === 0) resetPositions(room);
      broadcastRoom(room);
      return;
    }

    if (room.setPiece) {
      room.setPiece.timer--;
      if (room.setPiece.timer <= 0) room.setPiece = null;
    }

    if (Object.keys(room.users).length > 0 && !room.setPiece) {
      room.timeLeft -= 1 / 50;
      if (room.timeLeft <= 0) { room.timeLeft = 0; room.matchEnded = true; }
    }

    room.entities.forEach(e => {
      const controller = e.controllerUserId ? room.users[e.controllerUserId] : null;
      const statFactor = 1 + (e.stat - 75) * 0.007;

      if (e.tackleCooldown > 0) e.tackleCooldown--;
      if (e.tackleTimer > 0) e.tackleTimer--;
      if (e.stunTimer > 0) { e.stunTimer--; return; }

      // 세트피스 대기 중일 때 키커 외 이동 제한
      if (room.setPiece && room.ball.ownerEid === e.eid) {
        if (controller) {
          const inp = controller.input;
          if (inp.up) e.facing = -Math.PI / 2;
          if (inp.down) e.facing = Math.PI / 2;
          if (inp.left) e.facing = Math.PI;
          if (inp.right) e.facing = 0;
          if (inp.shoot) { e.chargeType = 'shoot'; e.charge = Math.min(100, e.charge + 6); }
          else if (inp.pass) { e.chargeType = 'pass'; e.charge = Math.min(100, e.charge + 7); }
          else if (e.charge > 0) executeKick(room, e, e.chargeType, e.charge / 100);
        } else {
          updateEntityAI(room, e);
        }
        return;
      }

      if (controller) {
        const inp = controller.input;
        let moveAccel = 0.92 * statFactor;

        if (inp.sprint && e.stamina > 3) {
          moveAccel *= 1.32;
          e.stamina = Math.max(0, e.stamina - 0.5);
        } else {
          e.stamina = Math.min(100, e.stamina + 0.35);
        }

        if (e.tackleTimer === 0) {
          let ix = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
          let iy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
          if (ix !== 0 || iy !== 0) {
            const norm = Math.hypot(ix, iy);
            e.vx += (ix / norm) * moveAccel;
            e.vy += (iy / norm) * moveAccel;
          } else {
            e.vx *= 0.72;
            e.vy *= 0.72;
          }
        }

        if (inp.shoot) {
          e.chargeType = 'shoot';
          e.charge = Math.min(100, e.charge + 6);
          if (e.charge >= 100) executeKick(room, e, 'shoot', 1.0);
        } else if (inp.pass) {
          e.chargeType = 'pass';
          e.charge = Math.min(100, e.charge + 7);
          if (e.charge >= 100) executeKick(room, e, 'pass', 0.8);
        } else if (inp.through) {
          e.chargeType = 'through';
          e.charge = Math.min(100, e.charge + 7);
          if (e.charge >= 100) executeKick(room, e, 'through', 0.85);
        } else if (e.charge > 0) {
          const distToBall = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
          if (room.ball.ownerEid === e.eid || distToBall < PLAYER_R + BALL_R + 34) {
            executeKick(room, e, e.chargeType, Math.max(0.35, e.charge / 100));
          } else {
            e.charge = 0;
            e.chargeType = null;
          }
        }
      } else {
        updateEntityAI(room, e);
        e.stamina = Math.min(100, e.stamina + 0.3);
      }

      e.vx *= 0.85;
      e.vy *= 0.85;
      e.x += e.vx;
      e.y += e.vy;

      const spd = Math.hypot(e.vx, e.vy);
      if (spd > 0.35) {
        e.facing = Math.atan2(e.vy, e.vx);
        e.animFrame += spd * 0.14;
      }

      e.x = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, e.x));
      e.y = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, e.y));

      // 슬라이딩 태클(tackleTimer > 0) 시 볼 탈취 및 파울 판정
      if (e.tackleTimer > 0) {
        room.entities.forEach(victim => {
          if (victim.side === e.side || victim.stunTimer > 0) return;
          const dVictim = Math.hypot(victim.x - e.x, victim.y - e.y);
          if (dVictim < PLAYER_R * 2.1) {
            const dBall = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
            // 공보다 사람을 먼저 가격하면 파울 선언!
            if (dBall > PLAYER_R + BALL_R + 12) {
              victim.stunTimer = 60;
              e.tackleTimer = 0;
              const inBox = (victim.side === 'red' && victim.x > FIELD_W - 245 && Math.abs(victim.y - FIELD_H / 2) < 240) ||
                            (victim.side === 'blue' && victim.x < 245 && Math.abs(victim.y - FIELD_H / 2) < 240);
              if (inBox) {
                const pkX = victim.side === 'red' ? FIELD_W - 165 : 165;
                triggerSetPiece(room, 'PENALTY', victim.side, pkX, FIELD_H / 2, '🚨 페널티 박스 내 파울! 페널티킥(PK)!');
              } else {
                triggerSetPiece(room, 'FREE_KICK', victim.side, victim.x, victim.y, '🟨 반칙! 프리킥 선언!');
              }
            } else {
              // 클린 태클 성공 -> 공 탈취
              room.ball.ownerEid = e.eid;
              room.ball.lastTouchSide = e.side;
              victim.stunTimer = 25;
            }
          }
        });
      }

      // 드리블(볼 소유 및 탈취) 판정
      const distToBall = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
      if (distToBall < PLAYER_R + BALL_R + 10 && room.ball.z < 18) {
        if (!room.ball.ownerEid) {
          room.ball.ownerEid = e.eid;
          room.ball.lastTouchSide = e.side;
        } else if (room.ball.ownerEid !== e.eid) {
          const curOwner = room.entities.find(o => o.eid === room.ball.ownerEid);
          if (curOwner && curOwner.side !== e.side) {
            // 상대 선수에게 다가가면 확률/유저 우위로 공을 뺏음
            const stealChance = controller ? 0.25 : 0.08;
            if (Math.random() < stealChance) {
              room.ball.ownerEid = e.eid;
              room.ball.lastTouchSide = e.side;
            }
          }
        }
      }
    });

    // 선수 간 충돌
    for (let i = 0; i < room.entities.length; i++) {
      for (let j = i + 1; j < room.entities.length; j++) {
        const p1 = room.entities[i], p2 = room.entities[j];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.hypot(dx, dy);
        if (dist < PLAYER_R * 2 && dist > 0) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (PLAYER_R * 2 - dist) / 2;
          p1.x -= nx * overlap; p1.y -= ny * overlap;
          p2.x += nx * overlap; p2.y += ny * overlap;
        }
      }
    }

    // 드리블 중 공 이동
    if (room.ball.ownerEid) {
      const dribbler = room.entities.find(e => e.eid === room.ball.ownerEid);
      if (dribbler) {
        const dribbleOffset = PLAYER_R + BALL_R - 1;
        const targetBX = dribbler.x + Math.cos(dribbler.facing) * dribbleOffset;
        const targetBY = dribbler.y + Math.sin(dribbler.facing) * dribbleOffset;
        room.ball.x += (targetBX - room.ball.x) * 0.72;
        room.ball.y += (targetBY - room.ball.y) * 0.72;
        room.ball.vx = dribbler.vx;
        room.ball.vy = dribbler.vy;
        room.ball.z = 0;
      } else {
        room.ball.ownerEid = null;
      }
    } else {
      room.ball.x += room.ball.vx;
      room.ball.y += room.ball.vy;
      room.ball.vx *= 0.985;
      room.ball.vy *= 0.985;

      if (room.ball.z > 0 || room.ball.vz !== 0) {
        room.ball.z += room.ball.vz;
        room.ball.vz -= 0.35;
        if (room.ball.z <= 0) {
          room.ball.z = 0;
          room.ball.vz = Math.abs(room.ball.vz) > 1.5 ? -room.ball.vz * 0.55 : 0;
        }
      }
    }

    // 터치라인 아웃 -> 스로인
    if (!room.setPiece && (room.ball.y < 0 || room.ball.y > FIELD_H)) {
      const throwSide = room.ball.lastTouchSide === 'red' ? 'blue' : 'red';
      const clampedX = Math.max(40, Math.min(FIELD_W - 40, room.ball.x));
      const clampedY = room.ball.y < 0 ? 14 : FIELD_H - 14;
      triggerSetPiece(room, 'THROW_IN', throwSide, clampedX, clampedY, `🤾 ${throwSide === 'red' ? 'RED' : 'BLUE'} 스로인!`);
    }

    // 골라인 판정 -> 골 / 코너킥 / 골킥
    const inGoalY = room.ball.y > (FIELD_H - GOAL_H) / 2 && room.ball.y < (FIELD_H + GOAL_H) / 2;
    if (!room.setPiece && room.ball.x < 0) {
      if (inGoalY) {
        room.score.blue++;
        room.goalCooldown = 90;
        room.ball.ownerEid = null;
      } else if (room.ball.lastTouchSide === 'red') {
        // 수비(RED) 맞고 나감 -> 공격(BLUE) 코너킥
        const cornerY = room.ball.y < FIELD_H / 2 ? 18 : FIELD_H - 18;
        triggerSetPiece(room, 'CORNER', 'blue', 18, cornerY, '🚩 BLUE 코너킥!');
      } else {
        // 공격(BLUE) 맞고 나감 -> 수비(RED) 골킥
        triggerSetPiece(room, 'GOAL_KICK', 'red', 95, FIELD_H / 2, '🥅 RED 골킥!');
      }
    } else if (!room.setPiece && room.ball.x > FIELD_W) {
      if (inGoalY) {
        room.score.red++;
        room.goalCooldown = 90;
        room.ball.ownerEid = null;
      } else if (room.ball.lastTouchSide === 'blue') {
        // 수비(BLUE) 맞고 나감 -> 공격(RED) 코너킥
        const cornerY = room.ball.y < FIELD_H / 2 ? 18 : FIELD_H - 18;
        triggerSetPiece(room, 'CORNER', 'red', FIELD_W - 18, cornerY, '🚩 RED 코너킥!');
      } else {
        // 공격(RED) 맞고 나감 -> 수비(BLUE) 골킥
        triggerSetPiece(room, 'GOAL_KICK', 'blue', FIELD_W - 95, FIELD_H / 2, '🥅 BLUE 골킥!');
      }
    }

    broadcastRoom(room);
  });
}, 1000 / 50);

function broadcastRoom(room) {
  const payload = JSON.stringify({ type: 'state', state: serializeRoom(room) });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
