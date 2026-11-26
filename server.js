const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/game-stream' });

// 대형 경기장 규격
const FIELD_W = 1800;
const FIELD_H = 1100;
const GOAL_H = 220;
const PLAYER_R = 19;
const BALL_R = 11;
const MATCH_DURATION = 180; // 3분 경기 (초 단위)

// 기본 팀 카드 데이터베이스 (팀 단위 스쿼드 4인)
const TEAM_CATALOG = [
  { code: 'KOR', name: '대한민국 국대', grade: 'SILVER', baseStat: 74, price: 800, color1: '#dc2626', color2: '#1d4ed8', roster: ['손흥민', '이강인', '김민재', '조현우'] },
  { code: 'TOT', name: '토트넘 홋스퍼', grade: 'SILVER', baseStat: 77, price: 1100, color1: '#f8fafc', color2: '#1e3a8a', roster: ['손흥민', '매디슨', '반더벤', '비카리오'] },
  { code: 'PSG', name: '파리 생제르맹', grade: 'GOLD', baseStat: 82, price: 2000, color1: '#1e3a8a', color2: '#dc2626', roster: ['뎀벨레', '이강인', '마르퀴뇨스', '돈나룸마'] },
  { code: 'BAY', name: '바이에른 뮌헨', grade: 'GOLD', baseStat: 84, price: 2400, color1: '#dc2626', color2: '#ffffff', roster: ['해리 케인', '무시알라', '김민재', '노이어'] },
  { code: 'ARS', name: '아스날 FC', grade: 'GOLD', baseStat: 83, price: 2200, color1: '#ef4444', color2: '#ffffff', roster: ['사카', '외데고르', '살리바', '라야'] },
  { code: 'BAR', name: 'FC 바르셀로나', grade: 'GOLD', baseStat: 85, price: 2800, color1: '#1d4ed8', color2: '#b91c1c', roster: ['야말', '페드리', '아라우호', '테어슈테겐'] },
  { code: 'MCI', name: '맨체스터 시티', grade: 'ICON', baseStat: 89, price: 4500, color1: '#38bdf8', color2: '#ffffff', roster: ['홀란드', '더브라위너', '디아스', '에데르송'] },
  { code: 'RMA', name: '레알 마드리드', grade: 'ICON', baseStat: 90, price: 5000, color1: '#ffffff', color2: '#eab308', roster: ['음바페', '벨링엄', '뤼디거', '쿠르투아'] }
];

// 이적시장 매물 목록 (팀 단위 거래)
let transferMarket = [
  { marketId: 'm1', seller: '시스템 구단', team: { ...TEAM_CATALOG[1], level: 1 }, price: 1000 },
  { marketId: 'm2', seller: '시스템 구단', team: { ...TEAM_CATALOG[3], level: 2 }, price: 2600 },
  { marketId: 'm3', seller: '시스템 구단', team: { ...TEAM_CATALOG[7], level: 1 }, price: 4800 }
];

// 방(Room) 저장소
const rooms = {};

function getOrCreateRoom(roomId) {
  const id = (roomId || 'public_1').slice(0, 15);
  if (!rooms[id]) {
    rooms[id] = {
      id,
      mode: '1v1', // '1v1' (유저 vs AI/유저 4인 스쿼드) 또는 '2v2' (2인 협동)
      users: {},
      entities: [], // 경기장 위 8명의 선수 (레드 4명, 블루 4명)
      ball: { x: FIELD_W / 2, y: FIELD_H / 2, vx: 0, vy: 0, lastTouchTeam: null },
      score: { red: 0, blue: 0 },
      timeLeft: MATCH_DURATION,
      goalCooldown: 0,
      matchEnded: false,
      rewardGiven: false
    };
    initRoomEntities(rooms[id]);
  }
  return rooms[id];
}

function initRoomEntities(room) {
  room.entities = [];
  const redUser = Object.values(room.users).find(u => u.teamSide === 'red');
  const blueUser = Object.values(room.users).find(u => u.teamSide === 'blue');

  const redTeamInfo = redUser ? redUser.activeTeam : { ...TEAM_CATALOG[0], level: 1 };
  const blueTeamInfo = blueUser ? blueUser.activeTeam : { ...TEAM_CATALOG[2], level: 1 };

  const formations = {
    red: [
      { role: 'ST', x: FIELD_W * 0.42, y: FIELD_H * 0.5 },
      { role: 'MF', x: FIELD_W * 0.30, y: FIELD_H * 0.32 },
      { role: 'DF', x: FIELD_W * 0.22, y: FIELD_H * 0.68 },
      { role: 'GK', x: 55, y: FIELD_H * 0.5 }
    ],
    blue: [
      { role: 'ST', x: FIELD_W * 0.58, y: FIELD_H * 0.5 },
      { role: 'MF', x: FIELD_W * 0.70, y: FIELD_H * 0.68 },
      { role: 'DF', x: FIELD_W * 0.78, y: FIELD_H * 0.32 },
      { role: 'GK', x: FIELD_W - 55, y: FIELD_H * 0.5 }
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
        teamName: tInfo.name,
        stat: tInfo.baseStat + (tInfo.level - 1) * 3,
        color1: side === 'red' ? '#ef4444' : '#3b82f6',
        color2: tInfo.color2,
        x: pos.x,
        y: pos.y,
        homeX: pos.x,
        homeY: pos.y,
        vx: 0,
        vy: 0,
        stamina: 100,
        charge: 0,
        chargeType: null, // 'shoot' | 'pass' | 'through'
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
  room.ball.vx = 0;
  room.ball.vy = 0;
  room.entities.forEach(e => {
    e.x = e.homeX;
    e.y = e.homeY;
    e.vx = 0;
    e.vy = 0;
    e.charge = 0;
  });
}

function switchClosestPlayer(room, user) {
  const sideEntities = room.entities.filter(e => e.side === user.teamSide);
  let bestIdx = 0;
  let minDist = Infinity;
  sideEntities.forEach((e, idx) => {
    if (idx === user.controlledIdx) return;
    // 다른 유저가 이미 조종 중이면 제외
    if (e.controllerUserId && e.controllerUserId !== user.id) return;
    const d = Math.hypot(room.ball.x - e.x, room.ball.y - e.y);
    if (d < minDist) {
      minDist = d;
      bestIdx = idx;
    }
  });
  user.controlledIdx = bestIdx;
  assignControllers(room);
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
      input: { up: false, down: false, left: false, right: false, shoot: false, pass: false, through: false, sprint: false },
      activeTeam: msg.activeTeam || { ...TEAM_CATALOG[0], level: 1 }
    };
    initRoomEntities(room);
  }

  const user = room.users[userId];
  user.lastSeen = Date.now();

  if (msg.type === 'join' || msg.type === 'syncTeam') {
    if (msg.nickname) user.name = msg.nickname.slice(0, 10);
    if (msg.teamSide && (msg.teamSide === 'red' || msg.teamSide === 'blue')) {
      user.teamSide = msg.teamSide;
    }
    if (msg.activeTeam) user.activeTeam = msg.activeTeam;
    if (msg.mode) room.mode = msg.mode;
    initRoomEntities(room);
  } else if (msg.type === 'input') {
    user.input = msg.input;
  } else if (msg.type === 'switchPlayer') {
    switchClosestPlayer(room, user);
  } else if (msg.type === 'restartMatch') {
    room.score = { red: 0, blue: 0 };
    room.timeLeft = MATCH_DURATION;
    room.matchEnded = false;
    room.rewardGiven = false;
    initRoomEntities(room);
    resetPositions(room);
  }
}

// 이적시장 API (팀 사고팔기)
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

// WebSocket 연결
wss.on('connection', (ws) => {
  let boundUserId = null;
  let boundRoomId = 'public_1';

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      boundUserId = msg.userId || boundUserId;
      boundRoomId = msg.roomId || boundRoomId;
      if (boundUserId) {
        handleAction(boundUserId, boundRoomId, msg);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (boundUserId && rooms[boundRoomId] && rooms[boundRoomId].users[boundUserId]) {
      delete rooms[boundRoomId].users[boundUserId];
      assignControllers(rooms[boundRoomId]);
    }
  });
});

// 학교 방화벽 우회용 HTTP 폴링 동기화
app.post('/api/sync', (req, res) => {
  const { userId, roomId, messages } = req.body;
  if (!userId) return res.status(400).end();
  const rId = roomId || 'public_1';
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
    mode: room.mode,
    users: room.users,
    entities: room.entities,
    ball: room.ball,
    score: room.score,
    timeLeft: Math.ceil(room.timeLeft),
    goalCooldown: room.goalCooldown,
    matchEnded: room.matchEnded
  };
}

// 지능형 골키퍼 및 필드 AI 로직
function updateEntityAI(room, e) {
  const ball = room.ball;
  const isRed = e.side === 'red';
  const ownGoalX = isRed ? 45 : FIELD_W - 45;
  const targetGoalX = isRed ? FIELD_W : 0;

  // 1. 골키퍼 AI (골대 라인에서 공의 Y좌표 추적 및 선방 다이빙)
  if (e.role === 'GK') {
    const goalMinY = (FIELD_H - GOAL_H) / 2 + 15;
    const goalMaxY = (FIELD_H + GOAL_H) / 2 - 15;
    const desiredY = Math.max(goalMinY, Math.min(goalMaxY, ball.y));
    const distToBall = Math.hypot(ball.x - e.x, ball.y - e.y);

    // 공이 페널티 박스 안으로 근접하면 전진 커트
    const desiredX = distToBall < 170
      ? ownGoalX + (isRed ? 65 : -65)
      : ownGoalX;

    const dx = desiredX - e.x;
    const dy = desiredY - e.y;
    const spd = 0.55 + (e.stat / 200);
    e.vx += Math.sign(dx) * Math.min(Math.abs(dx) * 0.08, spd);
    e.vy += Math.sign(dy) * Math.min(Math.abs(dy) * 0.08, spd);

    // 공을 잡거나 닿으면 전방으로 멀리 걷어내기
    if (distToBall < PLAYER_R + BALL_R + 10) {
      const clearAngle = Math.atan2((Math.random() - 0.5) * 400, targetGoalX - e.x);
      ball.vx = Math.cos(clearAngle) * 16;
      ball.vy = Math.sin(clearAngle) * 16;
    }
    return;
  }

  // 2. 필드 플레이어 AI (공과 가장 가까운 아군 1명만 압박, 나머지는 포지션 유지)
  const teammates = room.entities.filter(t => t.side === e.side && t.role !== 'GK');
  let closestToBall = teammates[0];
  let minD = Infinity;
  teammates.forEach(t => {
    const d = Math.hypot(ball.x - t.x, ball.y - t.y);
    if (d < minD) { minD = d; closestToBall = t; }
  });

  let destX = e.homeX + (ball.x - FIELD_W / 2) * 0.45;
  let destY = e.homeY + (ball.y - FIELD_H / 2) * 0.35;

  if (closestToBall && closestToBall.eid === e.eid) {
    const angleToGoal = Math.atan2(FIELD_H / 2 - ball.y, targetGoalX - ball.x);
    destX = ball.x - Math.cos(angleToGoal) * 26;
    destY = ball.y - Math.sin(angleToGoal) * 26;
  }

  const dx = destX - e.x;
  const dy = destY - e.y;
  const dist = Math.hypot(dx, dy);
  const accel = 0.48 + (e.stat / 250);
  if (dist > 8) {
    e.vx += (dx / dist) * accel;
    e.vy += (dy / dist) * accel;
  }

  // AI 슛/패스 판단
  const distToBall = Math.hypot(ball.x - e.x, ball.y - e.y);
  if (distToBall < PLAYER_R + BALL_R + 12) {
    const distToGoal = Math.hypot(targetGoalX - e.x, FIELD_H / 2 - e.y);
    const angleToGoal = Math.atan2((FIELD_H / 2 + (Math.random() - 0.5) * 120) - ball.y, targetGoalX - ball.x);
    const power = distToGoal < 520 ? 15 : 11;
    ball.vx = Math.cos(angleToGoal) * power;
    ball.vy = Math.sin(angleToGoal) * power;
    ball.lastTouchTeam = e.side;
  }
}

// 패스 타겟 자동 탐색 (진행 방향 앞쪽 아군)
function findPassTarget(room, passer) {
  const dirX = passer.side === 'red' ? 1 : -1;
  let best = null;
  let bestScore = -Infinity;
  room.entities.forEach(teammate => {
    if (teammate.side !== passer.side || teammate.eid === passer.eid) return;
    const dx = teammate.x - passer.x;
    const dy = teammate.y - passer.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 40 || dist > 850) return;
    const forwardBonus = dx * dirX * 0.5;
    const score = forwardBonus - dist * 0.3;
    if (score > bestScore) {
      bestScore = score;
      best = teammate;
    }
  });
  return best;
}

// 메인 50FPS 물리 & 경기 루프
setInterval(() => {
  const now = Date.now();
  Object.values(rooms).forEach(room => {
    // 6초 이상 응답 없는 HTTP 유저 제거
    let changed = false;
    Object.values(room.users).forEach(u => {
      if (now - u.lastSeen > 6000) {
        delete room.users[u.id];
        changed = true;
      }
    });
    if (changed) assignControllers(room);

    if (room.matchEnded) {
      broadcastRoom(room);
      return;
    }

    if (room.goalCooldown > 0) {
      room.goalCooldown--;
      if (room.goalCooldown === 0) resetPositions(room);
      broadcastRoom(room);
      return;
    }

    // 경기 시간 감소 (유저가 1명이라도 있을 때)
    if (Object.keys(room.users).length > 0) {
      room.timeLeft -= 1 / 50;
      if (room.timeLeft <= 0) {
        room.timeLeft = 0;
        room.matchEnded = true;
      }
    }

    room.entities.forEach(e => {
      const controller = e.controllerUserId ? room.users[e.controllerUserId] : null;
      const statFactor = 1 + (e.stat - 70) * 0.008;

      if (controller) {
        const inp = controller.input;
        let baseAccel = 0.58 * statFactor;
        if (inp.sprint && e.stamina > 5) {
          baseAccel *= 1.38;
          e.stamina = Math.max(0, e.stamina - 0.6);
        } else {
          e.stamina = Math.min(100, e.stamina + 0.25);
        }

        if (inp.up) e.vy -= baseAccel;
        if (inp.down) e.vy += baseAccel;
        if (inp.left) e.vx -= baseAccel;
        if (inp.right) e.vx += baseAccel;

        // 슛/패스 차징
        if (inp.shoot) {
          e.chargeType = 'shoot';
          e.charge = Math.min(100, e.charge + 4.5);
        } else if (inp.pass) {
          e.chargeType = 'pass';
          e.charge = Math.min(100, e.charge + 6);
        } else if (inp.through) {
          e.chargeType = 'through';
          e.charge = Math.min(100, e.charge + 6);
        } else if (e.charge > 0) {
          const dx = room.ball.x - e.x;
          const dy = room.ball.y - e.y;
          const dist = Math.hypot(dx, dy);

          if (dist < PLAYER_R + BALL_R + 24) {
            if (e.chargeType === 'shoot') {
              const power = (11 + (e.charge / 100) * 13) * statFactor;
              const speed = Math.hypot(e.vx, e.vy);
              const dirX = speed > 0.3 ? e.vx / speed : (e.side === 'red' ? 1 : -1);
              const dirY = speed > 0.3 ? e.vy / speed : 0;
              room.ball.vx = dirX * power;
              room.ball.vy = dirY * power;
            } else {
              const target = findPassTarget(room, e);
              if (target) {
                const leadX = e.chargeType === 'through' ? (e.side === 'red' ? 110 : -110) : 0;
                const angle = Math.atan2(target.y - room.ball.y, (target.x + leadX) - room.ball.x);
                const passSpeed = (12 + (e.charge / 100) * 6) * statFactor;
                room.ball.vx = Math.cos(angle) * passSpeed;
                room.ball.vy = Math.sin(angle) * passSpeed;
              } else {
                room.ball.vx = (dx / dist) * 13;
                room.ball.vy = (dy / dist) * 13;
              }
            }
            room.ball.lastTouchTeam = e.side;
          }
          e.charge = 0;
          e.chargeType = null;
        }
      } else {
        updateEntityAI(room, e);
        e.stamina = Math.min(100, e.stamina + 0.3);
      }

      e.vx *= 0.87;
      e.vy *= 0.87;
      e.x += e.vx;
      e.y += e.vy;

      e.x = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, e.x));
      e.y = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, e.y));

      // 드리블(공 접촉)
      const dx = room.ball.x - e.x;
      const dy = room.ball.y - e.y;
      const dist = Math.hypot(dx, dy);
      if (dist < PLAYER_R + BALL_R && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = (PLAYER_R + BALL_R) - dist;
        room.ball.x += nx * overlap;
        room.ball.y += ny * overlap;
        room.ball.vx = nx * 4.5 + e.vx * 0.7;
        room.ball.vy = ny * 4.5 + e.vy * 0.7;
        room.ball.lastTouchTeam = e.side;
      }
    });

    // 선수 간 충돌 방지
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

    // 공 물리
    room.ball.x += room.ball.vx;
    room.ball.y += room.ball.vy;
    room.ball.vx *= 0.986;
    room.ball.vy *= 0.986;

    if (room.ball.y - BALL_R < 0) { room.ball.y = BALL_R; room.ball.vy *= -0.85; }
    if (room.ball.y + BALL_R > FIELD_H) { room.ball.y = FIELD_H - BALL_R; room.ball.vy *= -0.85; }

    const inGoalY = room.ball.y > (FIELD_H - GOAL_H) / 2 && room.ball.y < (FIELD_H + GOAL_H) / 2;
    if (room.ball.x - BALL_R < 0) {
      if (inGoalY) {
        room.score.blue++;
        room.goalCooldown = 90;
      } else {
        room.ball.x = BALL_R;
        room.ball.vx *= -0.85;
      }
    } else if (room.ball.x + BALL_R > FIELD_W) {
      if (inGoalY) {
        room.score.red++;
        room.goalCooldown = 90;
      } else {
        room.ball.x = FIELD_W - BALL_R;
        room.ball.vx *= -0.85;
      }
    }

    broadcastRoom(room);
  });
}, 1000 / 50);

function broadcastRoom(room) {
  const payload = JSON.stringify({ type: 'state', state: serializeRoom(room) });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
