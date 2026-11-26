const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/game-stream' });

const FIELD_W = 1000;
const FIELD_H = 600;
const GOAL_H = 160;
const PLAYER_R = 18;
const BALL_R = 11;

let players = {};
let gameMode = '2v2';
let useAI = true;
let score = { red: 0, blue: 0 };
let goalCooldown = 0;

let ball = {
  x: FIELD_W / 2,
  y: FIELD_H / 2,
  vx: 0,
  vy: 0
};

function createPlayer(id, team) {
  return {
    id,
    name: `선수_${id.substring(0, 4)}`,
    team,
    isBot: false,
    lastSeen: Date.now(),
    x: team === 'red' ? FIELD_W * 0.25 : FIELD_W * 0.75,
    y: FIELD_H / 2,
    vx: 0,
    vy: 0,
    input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
    charge: 0,
    dashCooldown: 0
  };
}

function resetPositions() {
  ball.x = FIELD_W / 2;
  ball.y = FIELD_H / 2;
  ball.vx = 0;
  ball.vy = 0;

  let redIdx = 0;
  let blueIdx = 0;
  Object.values(players).forEach(p => {
    p.vx = 0;
    p.vy = 0;
    if (p.team === 'red') {
      p.x = FIELD_W * 0.25;
      p.y = FIELD_H * (0.35 + redIdx * 0.3);
      redIdx++;
    } else {
      p.x = FIELD_W * 0.75;
      p.y = FIELD_H * (0.35 + blueIdx * 0.3);
      blueIdx++;
    }
  });
}

function syncBots() {
  Object.keys(players).forEach(id => {
    if (players[id].isBot) delete players[id];
  });

  if (!useAI) return;

  const targetPerTeam = gameMode === '1v1' ? 1 : 2;
  const humans = Object.values(players).filter(p => !p.isBot);
  let redCount = humans.filter(p => p.team === 'red').length;
  let blueCount = humans.filter(p => p.team === 'blue').length;

  while (redCount < targetPerTeam) {
    const botId = `bot_red_${redCount}`;
    players[botId] = {
      id: botId, name: `AI 레드 ${redCount + 1}`, team: 'red', isBot: true, lastSeen: Date.now(),
      x: FIELD_W * 0.25, y: FIELD_H * (0.35 + redCount * 0.3),
      vx: 0, vy: 0, input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
      charge: 0, dashCooldown: 0
    };
    redCount++;
  }

  while (blueCount < targetPerTeam) {
    const botId = `bot_blue_${blueCount}`;
    players[botId] = {
      id: botId, name: `AI 블루 ${blueCount + 1}`, team: 'blue', isBot: true, lastSeen: Date.now(),
      x: FIELD_W * 0.75, y: FIELD_H * (0.35 + blueCount * 0.3),
      vx: 0, vy: 0, input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
      charge: 0, dashCooldown: 0
    };
    blueCount++;
  }
}

function registerPlayer(id) {
  if (!players[id]) {
    const humans = Object.values(players).filter(p => !p.isBot);
    const redCount = humans.filter(p => p.team === 'red').length;
    const blueCount = humans.filter(p => p.team === 'blue').length;
    const assignedTeam = redCount <= blueCount ? 'red' : 'blue';
    players[id] = createPlayer(id, assignedTeam);
    syncBots();
  }
  players[id].lastSeen = Date.now();
}

function handleMessage(id, msg) {
  registerPlayer(id);
  if (msg.type === 'input' && players[id]) {
    players[id].input = msg.input;
  } else if (msg.type === 'settings') {
    if (players[id]) {
      if (msg.name) players[id].name = msg.name.slice(0, 10);
      if (msg.team) players[id].team = msg.team;
    }
    if (msg.gameMode) gameMode = msg.gameMode;
    if (typeof msg.useAI === 'boolean') useAI = msg.useAI;
    syncBots();
  } else if (msg.type === 'reset') {
    score = { red: 0, blue: 0 };
    resetPositions();
  }
}

// 1) WebSocket 연결 처리
wss.on('connection', (ws) => {
  const id = Math.random().toString(36).substring(2, 10);
  registerPlayer(id);
  ws.playerId = id;
  ws.send(JSON.stringify({ type: 'init', id, fieldW: FIELD_W, fieldH: FIELD_H, goalH: GOAL_H }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleMessage(id, msg);
    } catch (e) {}
  });

  ws.on('close', () => {
    delete players[id];
    syncBots();
  });
});

// 2) 학교 방화벽에서 WebSocket 차단 시 자동 전환되는 일반 HTTP 폴링 API
app.post('/api/sync', (req, res) => {
  const { id, messages } = req.body;
  if (!id) return res.status(400).end();
  registerPlayer(id);
  if (Array.isArray(messages)) {
    messages.forEach(m => handleMessage(id, m));
  }
  res.json({ players, ball, score, goalCooldown, gameMode, useAI });
});

function updateAI(p) {
  const targetGoalX = p.team === 'red' ? FIELD_W : 0;
  const targetGoalY = FIELD_H / 2;
  const angleToGoal = Math.atan2(targetGoalY - ball.y, targetGoalX - ball.x);
  let targetX = ball.x - Math.cos(angleToGoal) * 28;
  let targetY = ball.y - Math.sin(angleToGoal) * 28;

  if (p.id.endsWith('_1')) {
    targetX = p.team === 'red' ? Math.min(ball.x - 80, FIELD_W * 0.4) : Math.max(ball.x + 80, FIELD_W * 0.6);
    targetY = ball.y * 0.7 + (FIELD_H / 2) * 0.3;
  }

  const dx = targetX - p.x;
  const dy = targetY - p.y;
  p.input.right = dx > 10;
  p.input.left = dx < -10;
  p.input.down = dy > 10;
  p.input.up = dy < -10;

  const distToBall = Math.hypot(ball.x - p.x, ball.y - p.y);
  p.input.kick = distToBall < PLAYER_R + BALL_R + 12;
  p.input.dash = distToBall > 220 && Math.random() < 0.02;
}

// 메인 물리 루프
setInterval(() => {
  // 5초 이상 응답 없는 HTTP 유저 정리
  const now = Date.now();
  let removed = false;
  Object.values(players).forEach(p => {
    if (!p.isBot && now - p.lastSeen > 5000) {
      delete players[p.id];
      removed = true;
    }
  });
  if (removed) syncBots();

  if (goalCooldown > 0) {
    goalCooldown--;
    if (goalCooldown === 0) resetPositions();
  } else {
    const list = Object.values(players);

    list.forEach(p => {
      if (p.isBot) updateAI(p);

      const accel = 0.65;
      if (p.input.up) p.vy -= accel;
      if (p.input.down) p.vy += accel;
      if (p.input.left) p.vx -= accel;
      if (p.input.right) p.vx += accel;

      if (p.dashCooldown > 0) p.dashCooldown--;
      if (p.input.dash && p.dashCooldown === 0) {
        const speed = Math.hypot(p.vx, p.vy);
        if (speed > 0.1) {
          p.vx = (p.vx / speed) * 12;
          p.vy = (p.vy / speed) * 12;
          p.dashCooldown = 70;
        }
      }

      p.vx *= 0.88;
      p.vy *= 0.88;
      p.x += p.vx;
      p.y += p.vy;

      p.x = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, p.x));
      p.y = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, p.y));

      if (p.input.kick) {
        p.charge = Math.min(100, p.charge + 5);
      } else if (p.charge > 0) {
        const dx = ball.x - p.x;
        const dy = ball.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist < PLAYER_R + BALL_R + 18) {
          const power = 8 + (p.charge / 100) * 12;
          ball.vx = (dx / dist) * power;
          ball.vy = (dy / dist) * power;
        }
        p.charge = 0;
      }

      if (p.isBot && p.input.kick) {
        const dx = ball.x - p.x;
        const dy = ball.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist < PLAYER_R + BALL_R + 14) {
          ball.vx = (dx / dist) * 11;
          ball.vy = (dy / dist) * 11;
        }
      }

      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < PLAYER_R + BALL_R && dist > 0) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = (PLAYER_R + BALL_R) - dist;
        ball.x += nx * overlap;
        ball.y += ny * overlap;
        ball.vx = nx * 5 + p.vx * 0.6;
        ball.vy = ny * 5 + p.vy * 0.6;
      }
    });

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p1 = list[i], p2 = list[j];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.hypot(dx, dy);
        if (dist < PLAYER_R * 2 && dist > 0) {
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = (PLAYER_R * 2 - dist) / 2;
          p1.x -= nx * overlap;
          p1.y -= ny * overlap;
          p2.x += nx * overlap;
          p2.y += ny * overlap;
        }
      }
    }

    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vx *= 0.985;
    ball.vy *= 0.985;

    if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy *= -0.85; }
    if (ball.y + BALL_R > FIELD_H) { ball.y = FIELD_H - BALL_R; ball.vy *= -0.85; }

    const inGoalY = ball.y > (FIELD_H - GOAL_H) / 2 && ball.y < (FIELD_H + GOAL_H) / 2;

    if (ball.x - BALL_R < 0) {
      if (inGoalY) {
        score.blue++;
        goalCooldown = 90;
      } else {
        ball.x = BALL_R;
        ball.vx *= -0.85;
      }
    } else if (ball.x + BALL_R > FIELD_W) {
      if (inGoalY) {
        score.red++;
        goalCooldown = 90;
      } else {
        ball.x = FIELD_W - BALL_R;
        ball.vx *= -0.85;
      }
    }
  }

  const statePayload = JSON.stringify({ type: 'state', players, ball, score, goalCooldown, gameMode, useAI });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(statePayload);
    }
  });
}, 1000 / 50);

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
