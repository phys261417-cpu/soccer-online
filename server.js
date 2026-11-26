const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 경기장 규격 설정
const FIELD_W = 1000;
const FIELD_H = 600;
const GOAL_H = 160;
const PLAYER_R = 18;
const BALL_R = 11;

// 게임 상태 저장소
let players = {};
let gameMode = '2v2'; // '1v1' or '2v2'
let useAI = true;
let score = { red: 0, blue: 0 };
let goalCooldown = 0;

let ball = {
  x: FIELD_W / 2,
  y: FIELD_H / 2,
  vx: 0,
  vy: 0
};

function resetPositions(scorer) {
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

// AI 봇 관리 (부족한 인원 자동 채우기)
function syncBots() {
  // 기존 봇 제거 후 인원수에 맞춰 재배치
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
      id: botId, name: `AI 레드 ${redCount + 1}`, team: 'red', isBot: true,
      x: FIELD_W * 0.25, y: FIELD_H * (0.35 + redCount * 0.3),
      vx: 0, vy: 0, input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
      charge: 0, dashCooldown: 0
    };
    redCount++;
  }

  while (blueCount < targetPerTeam) {
    const botId = `bot_blue_${blueCount}`;
    players[botId] = {
      id: botId, name: `AI 블루 ${blueCount + 1}`, team: 'blue', isBot: true,
      x: FIELD_W * 0.75, y: FIELD_H * (0.35 + blueCount * 0.3),
      vx: 0, vy: 0, input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
      charge: 0, dashCooldown: 0
    };
    blueCount++;
  }
}

io.on('connection', (socket) => {
  console.log('플레이어 접속:', socket.id);

  // 팀 자동 배정 (인원 적은 쪽으로)
  const humans = Object.values(players).filter(p => !p.isBot);
  const redCount = humans.filter(p => p.team === 'red').length;
  const blueCount = humans.filter(p => p.team === 'blue').length;
  const assignedTeam = redCount <= blueCount ? 'red' : 'blue';

  players[socket.id] = {
    id: socket.id,
    name: `선수_${socket.id.substring(0, 4)}`,
    team: assignedTeam,
    isBot: false,
    x: assignedTeam === 'red' ? FIELD_W * 0.25 : FIELD_W * 0.75,
    y: FIELD_H / 2,
    vx: 0,
    vy: 0,
    input: { up: false, down: false, left: false, right: false, kick: false, dash: false },
    charge: 0,
    dashCooldown: 0
  };

  syncBots();

  // 초기 정보 전송
  socket.emit('init', { id: socket.id, fieldW: FIELD_W, fieldH: FIELD_H, goalH: GOAL_H });

  // 조작 입력 수신
  socket.on('input', (inputData) => {
    if (players[socket.id]) {
      players[socket.id].input = inputData;
    }
  });

  // 닉네임 및 팀 변경
  socket.on('updateSettings', (data) => {
    if (players[socket.id]) {
      if (data.name) players[socket.id].name = data.name.slice(0, 10);
      if (data.team) players[socket.id].team = data.team;
    }
    if (data.gameMode) gameMode = data.gameMode;
    if (typeof data.useAI === 'boolean') useAI = data.useAI;
    syncBots();
  });

  // 경기 리셋
  socket.on('resetMatch', () => {
    score = { red: 0, blue: 0 };
    resetPositions();
  });

  socket.on('disconnect', () => {
    console.log('플레이어 퇴장:', socket.id);
    delete players[socket.id];
    syncBots();
  });
});

// AI 두뇌 업데이트
function updateAI(p) {
  // 공의 위치와 상대 골대 방향 계산
  const targetGoalX = p.team === 'red' ? FIELD_W : 0;
  const targetGoalY = FIELD_H / 2;

  // 슛 각도 잡기: 공 뒤쪽으로 이동
  const angleToGoal = Math.atan2(targetGoalY - ball.y, targetGoalX - ball.x);
  let targetX = ball.x - Math.cos(angleToGoal) * 28;
  let targetY = ball.y - Math.sin(angleToGoal) * 28;

  // 2vs2일 때 한 명은 수비 위치 유지
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

  // 공과 가까우면 슛!
  const distToBall = Math.hypot(ball.x - p.x, ball.y - p.y);
  p.input.kick = distToBall < PLAYER_R + BALL_R + 12;
  p.input.dash = distToBall > 220 && Math.random() < 0.02;
}

// 메인 게임 물리 루프 (60 FPS)
setInterval(() => {
  if (goalCooldown > 0) {
    goalCooldown--;
    if (goalCooldown === 0) resetPositions();
    io.emit('state', { players, ball, score, goalCooldown, gameMode, useAI });
    return;
  }

  const list = Object.values(players);

  // 1. 플레이어 이동 및 킥 처리
  list.forEach(p => {
    if (p.isBot) updateAI(p);

    const accel = 0.55;
    if (p.input.up) p.vy -= accel;
    if (p.input.down) p.vy += accel;
    if (p.input.left) p.vx -= accel;
    if (p.input.right) p.vx += accel;

    // 대시 (스태미나 쿨타임)
    if (p.dashCooldown > 0) p.dashCooldown--;
    if (p.input.dash && p.dashCooldown === 0) {
      const speed = Math.hypot(p.vx, p.vy);
      if (speed > 0.1) {
        p.vx = (p.vx / speed) * 11;
        p.vy = (p.vy / speed) * 11;
        p.dashCooldown = 90; // 1.5초 쿨타임
      }
    }

    // 마찰력
    p.vx *= 0.88;
    p.vy *= 0.88;
    p.x += p.vx;
    p.y += p.vy;

    // 경기장 경계 제한
    p.x = Math.max(PLAYER_R, Math.min(FIELD_W - PLAYER_R, p.x));
    p.y = Math.max(PLAYER_R, Math.min(FIELD_H - PLAYER_R, p.y));

    // 슛 파워 차징
    if (p.input.kick) {
      p.charge = Math.min(100, p.charge + 4);
    } else if (p.charge > 0) {
      // 키를 뗐을 때 슛 발동
      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < PLAYER_R + BALL_R + 18) {
        const power = 7 + (p.charge / 100) * 11;
        ball.vx = (dx / dist) * power;
        ball.vy = (dy / dist) * power;
      }
      p.charge = 0;
    }

    // AI 즉발 킥 처리
    if (p.isBot && p.input.kick) {
      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < PLAYER_R + BALL_R + 14) {
        ball.vx = (dx / dist) * 11;
        ball.vy = (dy / dist) * 11;
      }
    }

    // 플레이어 <-> 공 물리 충돌 (드리블)
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < PLAYER_R + BALL_R && dist > 0) {
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = (PLAYER_R + BALL_R) - dist;
      ball.x += nx * overlap;
      ball.y += ny * overlap;
      ball.vx = nx * 4.5 + p.vx * 0.6;
      ball.vy = ny * 4.5 + p.vy * 0.6;
    }
  });

  // 2. 플레이어끼리 몸싸움 충돌
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

  // 3. 공 이동 및 벽/골대 판정
  ball.x += ball.vx;
  ball.y += ball.vy;
  ball.vx *= 0.985;
  ball.vy *= 0.985;

  // 위아래 벽 반사
  if (ball.y - BALL_R < 0) { ball.y = BALL_R; ball.vy *= -0.85; }
  if (ball.y + BALL_R > FIELD_H) { ball.y = FIELD_H - BALL_R; ball.vy *= -0.85; }

  // 골대 Y 범위 체크
  const inGoalY = ball.y > (FIELD_H - GOAL_H) / 2 && ball.y < (FIELD_H + GOAL_H) / 2;

  if (ball.x - BALL_R < 0) {
    if (inGoalY) {
      score.blue++;
      goalCooldown = 120; // 2초 세레머니 대기
    } else {
      ball.x = BALL_R;
      ball.vx *= -0.85;
    }
  } else if (ball.x + BALL_R > FIELD_W) {
    if (inGoalY) {
      score.red++;
      goalCooldown = 120;
    } else {
      ball.x = FIELD_W - BALL_R;
      ball.vx *= -0.85;
    }
  }

  io.emit('state', { players, ball, score, goalCooldown, gameMode, useAI });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`온라인 축구 게임 서버 실행 중: http://localhost:${PORT}`);
});
