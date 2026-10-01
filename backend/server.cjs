require('dotenv').config();

const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  Player,
  Room,
  GameSession,
  RoomManager,
  roomManager,
  ROOM_LIFECYCLE,
  configureRoomManager
} = require('./roomManager.cjs');
const { DailyStats } = require('./dailyStats.cjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(express.json());

let bannedWordRegexes = [];

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadBannedWords() {
  try {
    const dictPath = path.resolve(__dirname, '../frontend/assets/违规词库.txt');
    const raw = fs.readFileSync(dictPath, 'utf8');
    const words = Array.from(
      new Set(
        raw
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean)
      )
    ).sort((a, b) => b.length - a.length);

    bannedWordRegexes = words.map(word => new RegExp(escapeRegex(word), 'gi'));
    console.log(`[内容过滤] 已加载违规词 ${bannedWordRegexes.length} 条`);
  } catch (error) {
    bannedWordRegexes = [];
    console.warn('[内容过滤] 违规词库加载失败，将跳过文本过滤:', error.message);
  }
}

function sanitizeText(input) {
  if (input == null) return '';
  let text = String(input);
  if (!text || bannedWordRegexes.length === 0) return text;

  for (const regex of bannedWordRegexes) {
    text = text.replace(regex, match => '*'.repeat(match.length));
  }
  return text;
}

loadBannedWords();

// -------------------------- 工具函数（抽离通用逻辑）--------------------------
/**
 * 生成默认昵称（统一处理，避免重复）
 * @param {string} playerId - 玩家ID
 * @returns {string} 默认昵称
 */
function getDefaultNickname(playerId) {
  return `玩家_${playerId.slice(-4)}`;
}

/**
 * 获取广播目标（优先游戏会话，其次房间，避免重复判断）
 * @param {string} playerId - 玩家ID
 * @returns {GameSession|Room|null} 广播目标
 */
function getBroadcastTarget(playerId) {
  // 优先查找游戏会话
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (gameSession) return gameSession;
  // 其次查找房间
  return roomManager.getPlayerRoom(playerId) || null;
}

function requireBroadcastTarget(playerId) {
  const target = getBroadcastTarget(playerId);
  if (!target) throw new Error('玩家不在任何房间或游戏会话中');
  return target;
}

// -------------------------- 每日统计 --------------------------
// 实现与落盘都在 dailyStats.cjs：每天一份 JSON，重启接上、跨天归档
const dailyStats = new DailyStats();

// -------------------------- 服务端权威棋面 --------------------------
// gameSessionId -> AuthoritySession。规则计算全部在 authority.cjs 里完成，
// 服务端不再采信客户端上报的骰子点数与棋子位置。
const authority = require('./authority.cjs');
const { BotDriver } = require('./botDriver.cjs');
const authoritySessions = new Map();

function getAuthoritySession(gameSessionId) {
  return gameSessionId ? authoritySessions.get(gameSessionId) || null : null;
}

function dropAuthoritySession(gameSessionId) {
  if (!gameSessionId) return;
  botDriver.dropSession(gameSessionId);
  const waiter = animationWaiters.get(gameSessionId);
  if (waiter) finishAnimationWait(gameSessionId, waiter);
  animationAckers.delete(gameSessionId);
  authoritySessions.delete(gameSessionId);
}

// 把领域模型需要的外部能力注入进去
configureRoomManager({
  getDefaultNickname,
  dropAuthoritySession,
  stats: dailyStats
});

// 把权威快照同步进 gameData，让重连、观战、既有 HTTP 接口都看到同一份棋面
function mirrorSnapshot(gameSession, snapshot) {
  const data = gameSession.gameData;
  const previousPlayer = data.currentPlayer;
  const previousPhase = data.gamePhase;

  data.currentPlayer = snapshot.currentPlayer;
  data.gamePhase = snapshot.gamePhase === 'ended' ? 'finished' : snapshot.gamePhase;
  data.diceValue = snapshot.diceValue;
  data.winner = snapshot.winner;
  data.consecutiveSixes = snapshot.consecutiveSixes;
  data.currentRound = snapshot.round;
  data.pieceCount = snapshot.pieceCount;
  if (Array.isArray(snapshot.progressHistory)) {
    data.progressHistory = snapshot.progressHistory;
  }
  for (const color of Object.keys(snapshot.playerChess)) {
    data.playerChess[color] = snapshot.playerChess[color].map(chess => ({
      position: chess.position,
      finished: chess.finished
    }));
  }
  for (const attacker of Object.keys(snapshot.defeatCounts)) {
    data.defeatCounts[attacker] = { ...snapshot.defeatCounts[attacker] };
  }

  // 思考窗口只在这里开：换人，或同一人重新进入掷骰阶段（连投 6 重掷）。
  // 掷出点数后进入选子沿用同一扇窗：那一步不重置进度条。
  // 刷新、重连、补快照都只是重发同一扇窗，狂刷页面换不来额外思考时间
  const openedWindow = data.currentPlayer !== previousPlayer
    || (data.gamePhase === 'rolling' && previousPhase !== 'rolling' && previousPhase !== 'paused');
  if (openedWindow) {
    data.thinkingStartTime = Date.now();
    data.pausedTotalMs = 0;
  }
}

/** 把服务端维护的思考窗口带进快照：客户端据此渲染进度条，也据此判定超时 */
function attachTiming(snapshot, gameData) {
  snapshot.thinkingStartTime = gameData.thinkingStartTime || null;
  snapshot.pausedThinkingMs = gameData.pausedTotalMs || 0;
  return snapshot;
}

/** 结束暂停：把这段暂停时长折算进去，思考窗口顺延，不因暂停而流失 */
function accumulatePausedTime(gameData) {
  if (!gameData || !gameData.pausedAt) return;
  gameData.pausedTotalMs = (gameData.pausedTotalMs || 0) + (Date.now() - gameData.pausedAt);
  gameData.pausedAt = null;
}

/** 思考时间是否已经用完（与前端 gameState.THINKING_TIME 对齐；未正式开局不计时） */
function isThinkingExpired(gameSession, now) {
  const data = gameSession.gameData;
  if (!data || !data.gameOfficiallyStarted || !data.thinkingStartTime || data.isPaused) return false;
  if (data.gamePhase !== 'rolling' && data.gamePhase !== 'selecting') return false;
  const elapsed = now - data.thinkingStartTime - (data.pausedTotalMs || 0);
  return elapsed > THINKING_TIME_MS;
}

/** 快照是否已经体现出对局推进，用来把「尚未开局」与「进行中」区分开 */
function hasGameProgress(snapshot) {
  if (!snapshot) return false;
  if ((snapshot.round || 0) > 0 || (snapshot.diceValue || 0) > 0) return true;
  const playerChess = snapshot.playerChess || {};
  return Object.keys(playerChess).some(color => {
    const chesses = playerChess[color];
    return Array.isArray(chesses) && chesses.some(chess => chess && (chess.position !== -1 || chess.finished));
  });
}

async function startAuthoritySession(gameSession) {
  const colors = Array.from(gameSession.players.values()).map(p => p.color);
  const session = await authority.createAuthoritySession({
    gameSessionId: gameSession.gameSessionId,
    colors,
    pieceCount: gameSession.pieceCount,
    happy: gameSession.happyMode,
    skillMode: gameSession.skillMode,
    // 初始积分：默认 0，测试或自定义开局可用环境变量给一笔启动资金
    startEnergy: Number(process.env.START_ENERGY) || 0
  });
  authoritySessions.set(gameSession.gameSessionId, session);
  mirrorSnapshot(gameSession, session.snapshot());
  gameSession.broadcast(attachTiming(session.snapshot(), gameSession.gameData));
  console.log(`[权威棋面] 会话 ${gameSession.gameSessionId} 已接管，玩家颜色: ${colors.join(',')}`);
  return session;
}

function colorOfPlayer(gameSession, playerId) {
  const player = gameSession.players.get(playerId);
  return player ? player.color : null;
}

/**
 * 解析这次意图真正代表谁。
 * 托管玩家与 AI 电脑玩家的回合由房主浏览器代理执行，此时 message.playerId 才是被代理者；
 * 普通玩家只能代表自己，防止伪造他人身份。
 */
// 意图只能由玩家本人发起：AI 与托管回合现在由服务端自己驱动（botDriver），
// 房主不再代打，所以没有「替别人发意图」这回事
function resolveIntentActor(gameSession, senderId, requestedId) {
  return senderId;
}

// 旧协议中会直接改写服务端棋面的消息类型
const LEGACY_BOARD_REPORTS = new Set([
  'diceRoll', 'playerTurnChange', 'pieceMove', 'chessMove',
  'finalMoveResult', 'moveChessToStart', 'moveChessToFinish', 'noMovableChess',
  'defeatCountChange', 'boardSyncData'
]);

function isLegacyBoardReport(type) {
  return LEGACY_BOARD_REPORTS.has(type);
}

function isAuthorityManaged(playerId) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  return Boolean(gameSession && authoritySessions.has(gameSession.gameSessionId));
}

function handleSnapshotRequest(ws, playerId) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  // 对局已结束/会话已销毁时客户端的兜底心跳还会来要快照，这不是异常，
  // 静默忽略即可，报错只会把各端控制台刷满
  if (!gameSession) return;
  markGamePage(playerId);
  const session = getAuthoritySession(gameSession.gameSessionId);
  if (!session) return;
  ws.send(JSON.stringify(attachTiming(session.snapshot(), gameSession.gameData)));
}

// 重连与观战都走同一条补发路径，保证新连上来的人立刻拿到权威棋面
function sendSnapshotTo(ws, gameSessionId) {
  const session = getAuthoritySession(gameSessionId);
  if (!session || !ws || ws.readyState !== 1) return false;
  const gameSession = roomManager.getGameSession(gameSessionId);
  ws.send(JSON.stringify(attachTiming(session.snapshot(), gameSession ? gameSession.gameData : {})));
  return true;
}

// 页面刚加载完（刷新）时右侧面板是空的，这里把服务端留存的事件流与聊天补回去，
// 客户端用同一套事件回放层静默重建战报；只是普通的断线重连则面板内容仍在，
// 客户端不会请求历史，避免重复堆叠。
function sendGameInfoHistoryTo(ws, gameSession) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const session = getAuthoritySession(gameSession.gameSessionId);
  ws.send(JSON.stringify({
    type: 'gameInfoHistory',
    gameSessionId: gameSession.gameSessionId,
    events: session ? session.eventLog : [],
    chat: gameSession.chatHistory || []
  }));
}

function handleIntent(ws, playerId, message) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (!gameSession) throw new Error('玩家不在任何游戏会话中');
  markGamePage(playerId);
  const session = getAuthoritySession(gameSession.gameSessionId);
  if (!session) throw new Error('本局尚未由服务端接管');

  const actorId = resolveIntentActor(gameSession, playerId, message.playerId);
  const color = colorOfPlayer(gameSession, actorId);
  if (color === null) throw new Error('玩家不属于本局');

  const intent = message.intent || { type: message.action };

  // 暂停是对局的冻结状态：客户端漏检（旧页面、超时回调）也推不动棋面
  if (gameSession.gameData && gameSession.gameData.isPaused) {
    const rejectWs = roomManager.getPlayerConnection(playerId) || ws;
    rejectWs.send(JSON.stringify({
      type: 'intentRejected',
      gameSessionId: gameSession.gameSessionId,
      reason: '对局已暂停',
      intent
    }));
    return;
  }

  const result = session.applyIntent(color, intent);

  if (!result.ok) {
    // 被拒绝时退回请求者，托管方据此知道自己代理的动作没生效
    const rejectWs = roomManager.getPlayerConnection(playerId) || ws;
    rejectWs.send(JSON.stringify({
      type: 'intentRejected',
      gameSessionId: gameSession.gameSessionId,
      reason: result.error,
      intent
    }));
    return;
  }

  // 买道具后玩家要选点/选子，客户端会重置进度条：服务端同步开一扇新窗，
  // 否则玩家看着满格进度条、服务端却按旧窗口到点代走
  if (intent.type === 'item' && intent.item && gameSession.gameData) {
    gameSession.gameData.thinkingStartTime = Date.now();
    gameSession.gameData.pausedTotalMs = 0;
  }

  commitSnapshot(gameSession, result.snapshot);
}

/** 权威快照落地的唯一出口：镜像进 gameData 后广播，并在对局结束时就地收尾 */
function commitSnapshot(gameSession, snapshot) {
  mirrorSnapshot(gameSession, snapshot);
  // 一旦出现推进痕迹就固化「已正式开始」，让重连/断线处理能区分加载中与进行中
  if (!gameSession.gameData.gameOfficiallyStarted && hasGameProgress(snapshot)) {
    gameSession.gameData.gameOfficiallyStarted = true;
  }
  gameSession.broadcast(attachTiming(snapshot, gameSession.gameData));
  if (snapshot.gamePhase === 'ended' && gameSession.gameState === 'playing') {
    gameSession.gameState = 'finished';
  }
  // 轮到 AI 就接着往下推（驱动内部会判断暂停/结束，可安全重复调用）
  botDriver.kick(gameSession);
}


// -------------------------- 服务端 AI --------------------------
// 机器人与被托管玩家的回合不再由房主浏览器代打：服务端自己按节奏推，
// 房主切后台、关页面都不影响，看门狗退回「管人类挂机」的兜底角色
const isAiDrivenColor = (gameSession, color) => {
  for (const player of gameSession.players.values()) {
    if (player.color === color) return Boolean(player.isAI || player.isAITakeover);
  }
  return false;
};

const playerOfColor = (gameSession, color) => {
  for (const player of gameSession.players.values()) {
    if (player.color === color) return player;
  }
  return null;
};

const botDriver = new BotDriver({
  sessionOf: (gameSession) => getAuthoritySession(gameSession.gameSessionId),
  isAiDriven: isAiDrivenColor,
  difficultyOf: (gameSession, color) => {
    const player = playerOfColor(gameSession, color);
    return (player && player.difficulty) || 'easy';
  },
  isPaused: (gameSession) => Boolean(gameSession.gameData && gameSession.gameData.isPaused),
  isEnded: (gameSession) => gameSession.gameState !== 'playing',
  applyAction: (gameSession, color, action) => {
    const session = getAuthoritySession(gameSession.gameSessionId);
    if (!session || !action) throw new Error('没有可执行的动作');
    const result = session.applyIntent(color, action);
    if (!result.ok) throw new Error(result.error);
    commitSnapshot(gameSession, result.snapshot);
    return { events: result.snapshot.events, seq: result.snapshot.seq };
  },
  settled: (gameSession, seq) => waitForClientsSettled(gameSession, seq)
});

// -------------------------- 演完回执 --------------------------
// AI 的下一手要等各端把这一帧演完再出，节奏才跟人操作一样。
// 认不到回执（有人在刷新）、或者对端在后台（定时器被节流、动画要拖很久）就不等它，
// 别让整桌陪着慢；那台回前台时会自己拉全量快照追上来。
const ANIMATION_ACK_TIMEOUT_MS = 2500;
const animationWaiters = new Map(); // gameSessionId → { seq, pending:Set<playerId>, resolve, timer }
// 认得出会回执的客户端：从没回过执的（脚本、旧页面）不参与等待，免得每拍都等满超时
const animationAckers = new Map(); // gameSessionId → Set<playerId>
// 当前在后台的客户端：它自己报的（visibilityChange），后台期间也回执不了动画，一并摘出去
const backgroundPlayers = new Set(); // playerId
// 对局页面上的客户端：只有 game.html 会发这几类消息（回执、周期快照、重连对局、出手）。
// 大厅页连上 socket 时同样占着 playerConnections，但它不在对局里演动画，
// 等它等于每拍都要白等满回执超时；离开对局/断开时把这个标记清掉。
const gamePagePlayers = new Map(); // playerId → 最近一次对局页消息的时间
const GAME_PAGE_TTL_MS = 60000;
function markGamePage(playerId) {
  if (playerId) gamePagePlayers.set(playerId, Date.now());
}
function isOnGamePage(playerId) {
  const at = gamePagePlayers.get(playerId);
  return Boolean(at && Date.now() - at < GAME_PAGE_TTL_MS);
}

function connectedHumanIds(gameSession) {
  const ids = [];
  for (const [playerId, player] of gameSession.players) {
    if (player.isAI || backgroundPlayers.has(playerId) || !isOnGamePage(playerId)) continue;
    const ws = roomManager.getPlayerConnection(playerId);
    if (ws && ws.readyState === WebSocket.OPEN) ids.push(playerId);
  }
  return ids;
}

/**
 * 等各端把这一帧演完。
 * 返回值告诉驱动「是不是真有人回执」：有人回执 → 等回执花掉的时间就是这段演出的时长，
 * 驱动可以直接接下一拍；没人能回执（脚本、旧页面）→ 返回 false，让驱动按估时表配节奏。
 */
function waitForClientsSettled(gameSession, seq) {
  if (!gameSession || typeof seq !== 'number') return Promise.resolve(false);
  const ackers = animationAckers.get(gameSession.gameSessionId);
  const pending = new Set(connectedHumanIds(gameSession).filter((id) => ackers && ackers.has(id)));
  if (!pending.size) return Promise.resolve(false);

  const key = gameSession.gameSessionId;
  const previous = animationWaiters.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    previous.resolve(true);
  }

  return new Promise((resolve) => {
    const waiter = { seq, pending, resolve };
    waiter.timer = setTimeout(() => finishAnimationWait(key, waiter), ANIMATION_ACK_TIMEOUT_MS);
    animationWaiters.set(key, waiter);
  });
}

function finishAnimationWait(key, waiter) {
  if (animationWaiters.get(key) !== waiter) return;
  clearTimeout(waiter.timer);
  animationWaiters.delete(key);
  // 超时也算「等过了」：某一端卡住/切后台时让它自己追赶，别在它身上再叠一层停顿
  waiter.resolve(true);
}

/** 客户端把某一帧演完了 */
function handleAnimationDone(ws, playerId, message) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (!gameSession) return;
  const key = gameSession.gameSessionId;
  markGamePage(playerId);
  if (!animationAckers.has(key)) animationAckers.set(key, new Set());
  animationAckers.get(key).add(playerId);
  // 回执自己带了前后台标记：漏收 visibilityChange 时也按它记一份
  if (message.hidden) backgroundPlayers.add(playerId);
  else backgroundPlayers.delete(playerId);
  const waiter = animationWaiters.get(key);
  if (!waiter || message.seq < waiter.seq) return;
  // 后台页面的定时器被浏览器节流，它的「演完」会晚上很多，等它等于让整桌陪它慢
  waiter.pending.delete(playerId);
  if (!message.hidden && !waiter.pending.size) finishAnimationWait(gameSession.gameSessionId, waiter);
}

// -------------------------- 回合看门狗 --------------------------
// 看门狗现在只管人：思考窗口到点就替这位玩家走一步（防挂机、防刷新拖延），
// 再留一条「空闲过久」的兜底——AI 的回合已由服务端自己驱动（见 botDriver.cjs），
// 走到这里说明那条链也停了，按最小合法路径把回合交出去。
const WATCHDOG_INTERVAL_MS = 5000;

/** 单回合思考时长，与前端 gameState.THINKING_TIME 对齐；可用环境变量覆盖，便于测试 */
const THINKING_TIME_MS = Number(process.env.THINKING_TIME_MS) || 20000;

function startTurnWatchdog() {
  setInterval(() => {
    const now = Date.now();
    for (const [gameSessionId, session] of authoritySessions) {
      const gameSession = roomManager.getGameSession(gameSessionId);
      if (!gameSession) {
        authoritySessions.delete(gameSessionId);
        continue;
      }
      // 暂停是对局冻结状态，看门狗同样不许代走
      if (gameSession.gameData && gameSession.gameData.isPaused) continue;
      // 思考时间用完立刻代走：前端计时器可被刷新或改脚本绕开，
      // 这里才是「拖延时间拿不到额外回合」的保证
      const thinkingExpired = isThinkingExpired(gameSession, now);

      if (!thinkingExpired && !session.isStuck(now)) continue;

      const stuckColor = session.state.currentPlayer;
      const player = playerOfColor(gameSession, stuckColor);

      // 机器人 / 托管玩家的回合归 botDriver 按节奏走，看门狗只在它那条链真断了
      //（60 秒没动静）时才兜底；否则会在客户端还在演动画时插一脚，
      // 代走好几步却只播最后一帧，看着就是「一瞬间过去一手」
      if (player && (player.isAI || player.isAITakeover)) {
        if (!session.isStuck(now)) continue;
      } else if (thinkingExpired && player) {
        // 真人思考窗口到点：转成 AI 托管，让 botDriver 接手按正常节奏走完这一手，
        // 各端照常演动画、记战报（昵称上的【Bot】标记也是这么来的）
        player.isAITakeover = true;
        gameSession.broadcast({
          type: 'aiTakeoverChange',
          playerId: player.id,
          isActive: true,
          auto: true,
          reason: 'thinking_timeout',
          timestamp: now
        });
        botDriver.kick(gameSession);
        continue;
      }

      const results = session.advanceStuckTurn();
      if (!results.length) continue;

      commitSnapshot(gameSession, results[results.length - 1].snapshot);
      console.log(`[回合看门狗] 玩家 ${stuckColor} ${thinkingExpired ? '思考超时' : '空闲超时'}，服务端代走 ${results.length} 步`);
    }
  }, WATCHDOG_INTERVAL_MS);
}

/**
 * 房间验证中间件（统一权限校验）
 * @param {Function} handler - 业务处理函数
 * @param {boolean} requireHost - 是否需要房主权限
 * @returns {Function} 包装后的处理函数
 */
function withRoomValidation(handler, requireHost = false) {
  return (ws, playerId, message) => {
    const room = roomManager.getPlayerRoom(playerId);
    if (!room) throw new Error('玩家不在任何房间中');

    const player = room.players.get(playerId);
    if (!player) throw new Error('玩家不存在');

    if (requireHost && room.host.id !== playerId) throw new Error('只有房主可以执行此操作');

    return handler(ws, playerId, message, room, player);
  };
}

/**
 * 游戏会话验证中间件（统一校验）
 * @param {Function} handler - 业务处理函数
 * @returns {Function} 包装后的处理函数
 */
function withGameSessionValidation(handler) {
  return (ws, playerId, message) => {
    const gameSession = roomManager.getPlayerGameSession(playerId);
    if (!gameSession || !gameSession.players.get(playerId)) {
      return;
    }
    return handler(ws, playerId, message, gameSession, gameSession.players.get(playerId));
  };
}

// -------------------------- 断开连接处理（优化冗余逻辑）--------------------------
function handlePlayerDisconnect(playerId) {
  console.log(`处理玩家 ${playerId} 断开连接`);

  // 清理玩家连接映射
  roomManager.playerConnections.delete(playerId);
  // 前后台标记跟着连接走：断线的人已经不在「等演完」的名单里，别留脏标记
  backgroundPlayers.delete(playerId);
  // 对局页标记也摘掉：他要是只开着大厅，后面再断开就不该再往对局里播一条退出
  const wasOnGamePage = isOnGamePage(playerId);
  gamePagePlayers.delete(playerId);

  // 1. 游戏会话中处理
  let handledInSession = false;
  for (const gameSession of roomManager.gameSessions.values()) {
    if (!gameSession.players.has(playerId)) continue;

    handledInSession = true;
    const player = gameSession.players.get(playerId);
    if (player) {
      const wasHost = player.isHost || false;

      // 检查是否已经发送过退出消息，避免重复
      const alreadyLeft = !player.isConnected && !!player.disconnectedAt;

      player.isConnected = false;
      player.ws = null;
      player.disconnectedAt = player.disconnectedAt || Date.now();

      // 房主转移逻辑
      if (wasHost) {
        const doTransfer = () => {
          // 重新检查当前房主是否仍不在线（可能已经重连了）
          const currentHost = gameSession.players.get(playerId);
          const currentWs = roomManager.getPlayerConnection(playerId);
          const isCurrentWsOpen = currentWs && currentWs.readyState === 1;
          
          if (currentHost && currentHost.isConnected && isCurrentWsOpen) {
            console.log(`房主 ${playerId} 已在线，取消房主转移`);
            return;
          }

          // 如果在等待期间，有其他人通过重连已经接管了房主，也不需要再转移了
          const actualCurrentHost = Array.from(gameSession.players.values()).find(p => p.isHost);
          if (actualCurrentHost && actualCurrentHost.id !== playerId && actualCurrentHost.isConnected) {
             console.log(`房主已变更为 ${actualCurrentHost.id}，取消转移`);
             return;
          }

          // 找到第一个在线且WebSocket真实打开的真实玩家作为新房主
          let newHost = null;
          for (const [pId, p] of gameSession.players) {
            const pWs = roomManager.getPlayerConnection(pId);
            const isWsOpen = pWs && pWs.readyState === 1;
            if (pId !== playerId && p.isConnected && isWsOpen && !p.isAI) {
              newHost = p;
              break;
            }
          }

          if (newHost) {
            console.log(`房主 ${playerId} 离线，转移房主给 ${newHost.id}`);
            for (const [pId, p] of gameSession.players) {
              if (p) p.isHost = (pId === newHost.id);
            }
            gameSession.hostId = newHost.id;

            // 同步更新Room中的房主（如果房间存在）
            if (gameSession.roomCode) {
              const room = roomManager.getRoom(gameSession.roomCode);
              if (room) {
                const roomNewHost = room.players.get(newHost.id);
                if (roomNewHost) {
                  room.host = roomNewHost;
                  for (const p of room.players.values()) {
                    if (p) p.isHost = (p.id === roomNewHost.id);
                  }
                  console.log(`房间 ${room.code} 房主已同步更新为 ${newHost.id}`);
                }
              }
            }

            // 广播房主变更消息（各端会自己渲染一条提示，这里顺带留档供刷新后回放）
            recordHostChange(gameSession, newHost);
            gameSession.broadcast({
              type: 'hostChanged',
              oldHostId: playerId,
              newHostId: newHost.id,
              newHostNickname: newHost.nickname,
              gameSession: gameSession.toJSON(),
              timestamp: Date.now()
            });

            console.log(`新房主: ${newHost.id} (${newHost.nickname})`);
          } else {
            console.log(`房主 ${playerId} 断开连接，但没有其他在线玩家可以接管`);
          }
        };

        const timeSinceStart = Date.now() - (gameSession.createdAt || 0);
        const isInitialLoading = timeSinceStart < 15000;

        if (isInitialLoading) {
          console.log(`游戏刚开始（加载中），延迟 10 秒后检查是否需要转移房主`);
          setTimeout(doTransfer, 10000);
        } else {
          doTransfer();
        }
      }

      // 广播离线消息：已经报过离线的、或者本来就没在对局页面上的（只是大厅那条连接断了）
      // 都不再往对局里播「退出游戏」——否则回到房间列表再关窗口会白报一条
      if (!alreadyLeft && wasOnGamePage) {
        broadcastSystemChat(gameSession, `${player.nickname}退出游戏`);
      }
      // 广播断开状态（只发送玩家列表，不发送全量 gameData 减轻其他客户端解析负担）
      const playersArray = Array.from(gameSession.players.values()).map(p => ({
        id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
        isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
      }));
      gameSession.broadcast({
        type: 'playerDisconnected',
        playerId,
        players: playersArray
      });

      // 如果是当前玩家断线
      if (gameSession.gameData && player.color === gameSession.gameData.currentPlayer) {
        // 如果游戏尚未正式开始（首发玩家还没投骰子就跑了）
        if (!gameSession.gameData.gameOfficiallyStarted) {
          // 找到下一个在线的人类玩家
          const allPlayers = Array.from(gameSession.players.values());
          const humanPlayers = allPlayers.filter(p => !p.isAI && p.id !== playerId && p.isConnected);
          
          if (humanPlayers.length > 0) {
            // 按照颜色顺序找下一个
            const sortedHumans = humanPlayers.sort((a, b) => a.color - b.color);
            // 找比当前颜色大的最小颜色，如果没有就找最小的
            let nextHuman = sortedHumans.find(p => p.color > player.color);
            if (!nextHuman) nextHuman = sortedHumans[0];
            // 执行转移
            gameSession.gameData.currentPlayer = nextHuman.color;
            gameSession.gameData.thinkingStartTime = Date.now(); // 重置思考时间
            
            // 广播转移消息
            broadcastSystemChat(gameSession, `首发玩家离线，首发权转移给 ${nextHuman.nickname}`);
            
            gameSession.broadcast({
              type: 'playerTurnChange',
              newPlayer: nextHuman.color,
              timestamp: Date.now(),
              reason: 'first_player_disconnect'
            });
          } else {
            console.log(`[开局优化] 没有其他在线人类玩家可以接管首发权，保持原样（将由AI接管）`);
          }
        } else {
          console.log(`当前玩家${player.color}断线（游戏阶段：${gameSession.gameData.gamePhase}），等待超时自动接管`);
        }
      }

      // 同步更新房间中的玩家状态（如果房间存在）
      if (gameSession.roomCode) {
        const room = roomManager.getRoom(gameSession.roomCode);
        if (room) {
          const roomPlayer = room.players.get(playerId);
          if (roomPlayer) {
            roomPlayer.isConnected = false;
            roomPlayer.ws = null;
            roomPlayer.disconnectedAt = Date.now();
          }
          // 检查房间是否已没有人类玩家
          room.checkEmptyRoom();
        }
      }
    }
  }

  if (handledInSession) {
    return;
  }

  // 1.5 观战者处理
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (room) {
      room.spectators.delete(playerId);
      room.spectatorNames.delete(playerId);
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          gameSession.spectators.delete(playerId);
        }
      }
    }
    roomManager.playerSpectatingRooms.delete(playerId);
    return;
  }

  // 2. 房间中处理（非游戏状态）
  const roomCode = roomManager.playerRooms.get(playerId);
  if (!roomCode) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  // 游戏中保留位置
  if (room.gameState === 'playing') {
    const player = room.players.get(playerId);
    if (player) {
      player.isConnected = false;
      player.ws = null;
      player.disconnectedAt = Date.now();

      // 同步更新游戏会话中的玩家连接状态，确保重连信息能正确匹配
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          const sessionPlayer = gameSession.players.get(playerId);
          if (sessionPlayer) {
            sessionPlayer.isConnected = false;
          }
        }
      }

      // 广播离线消息
      broadcastSystemChat(room, `${player.nickname}退出游戏`);
      // 广播断开状态
      room.broadcast({
        type: 'playerDisconnected',
        playerId,
        room: room.toJSON()
      });
    }
    return;
  }

  // 3. 非游戏状态：30秒后移除玩家
  const player = room.players.get(playerId);
  if (player) {
    player.isConnected = false;
    player.ws = null;
    player.disconnectedAt = Date.now();

    // 检查房间是否已没有人类玩家
    room.checkEmptyRoom();

    room.broadcast({
      type: 'playerDisconnected',
      playerId,
      room: room.toJSON()
    });

    const timer = setTimeout(() => {
      console.log(`玩家 ${playerId} 重连超时，执行移除`);
      const currentPlayer = room.players.get(playerId);
      if (currentPlayer && !currentPlayer.isConnected) {
        room.removePlayer(playerId);
        roomManager.playerRooms.delete(playerId);

        if (room.players.size > 0) {
          // 如果房间中已经没有任何人类玩家（只剩AI），直接走房间销毁流程
          if (!room.hasHumanPlayers()) {
            console.log(`房间 ${roomCode} 仅剩AI玩家，立即销毁`);
            roomManager.immediateDestroyRoom(roomCode);
          } else {
            room.broadcast({
              type: 'playerLeft',
              playerId,
              room: room.toJSON()
            });
          }
        } else {
          console.log(`房间 ${roomCode} 已无玩家，立即销毁`);
          roomManager.immediateDestroyRoom(roomCode);
        }
      }
      roomManager.disconnectTimers.delete(playerId);
    }, 30000);
    roomManager.disconnectTimers.set(playerId, timer);
    return;
  }

  handlePlayerDisconnect(playerId);
}

function forceDetachPlayerFromExistingContexts(playerId, nextRoomCode = null, isSilentMigration = false) {
  const currentRoomCode = roomManager.playerRooms.get(playerId);
  const currentSessionId = roomManager.playerSessions.get(playerId);

  if (currentRoomCode && nextRoomCode && currentRoomCode === nextRoomCode) {
    return;
  }

  if (currentSessionId) {
    const gs = roomManager.getGameSession(currentSessionId);
    if (gs && gs.players && gs.players.has(playerId)) {
      const p = gs.players.get(playerId);
      if (p) {
        p.isConnected = false;
        p.ws = null;
        p.disconnectedAt = Date.now();
      }

      // 如果玩家是主动切换到其他房间/会话：
      // 1. 如果游戏已结束或未开始，彻底移除
      // 2. 如果游戏进行中，保留玩家数据（转为离线/被托管），仅删除 Session 映射
      if (gs.gameState !== 'playing') {
        gs.players.delete(playerId);
        // 显式清理音频加载状态等残留标记
        if (gs.audioLoadedPlayers) gs.audioLoadedPlayers.delete(playerId);
        if (gs.aiTakeoverPlayers) gs.aiTakeoverPlayers.delete(playerId);
      } else {
        console.log(`[迁移] 玩家 ${playerId} 正在游戏中迁移，保留会话内数据以供观战/托管`);
        // 确保被标记为托管（如果之前没托管的话）
        if (gs.aiTakeoverPlayers) gs.aiTakeoverPlayers.add(playerId);
      }

      // 如果是静默迁移，严禁发送任何广播
      if (!isSilentMigration) {
        try {
          broadcastSystemChat(gs, `${p?.nickname || playerId}退出游戏`);
          const detachPlayers = Array.from(gs.players.values()).map(p => ({
            id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
            isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
          }));
          gs.broadcast({
            type: 'playerDisconnected',
            playerId,
            players: detachPlayers
          });
        } catch (e) {
          console.error('forceDetachPlayerFromExistingContexts 游戏会话广播失败:', e);
        }
      } else {
        console.log(`[迁移] 玩家 ${playerId} 静默脱离旧游戏会话 ${currentSessionId}`);
      }
    }
    roomManager.playerSessions.delete(playerId);
  }

  if (currentRoomCode) {
    const room = roomManager.getRoom(currentRoomCode);
    if (room && room.players && room.players.has(playerId)) {
      const rp = room.players.get(playerId);
      if (rp) {
        rp.isConnected = false;
        rp.ws = null;
        rp.disconnectedAt = Date.now();
      }

      // 玩家已切换房间：从旧房间彻底移除
      room.removePlayer(playerId);

      // 如果是静默迁移，严禁发送任何广播
      if (!isSilentMigration) {
        try {
          room.broadcast({
            type: 'playerDisconnected',
            playerId,
            room: room.toJSON()
          });
        } catch (e) {
          console.error('forceDetachPlayerFromExistingContexts 房间广播失败:', e);
        }
      } else {
        console.log(`[迁移] 玩家 ${playerId} 静默脱离旧房间 ${currentRoomCode}`);
      }
    }
    roomManager.playerRooms.delete(playerId);
  }
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (data) => {
    try {
      const message = normalizeInboundMessage(JSON.parse(data));

      // 初始化玩家ID
      if (!playerId) {
        playerId = message.playerId?.startsWith('player_') ? message.playerId : generatePlayerId();
        console.log(`玩家 ${playerId} 连接`);
        // 发送连接确认
        ws.send(JSON.stringify({ type: 'connected', playerId }));
      }

      // 重连：取消断开定时器
      if (roomManager.disconnectTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectTimers.get(playerId));
        roomManager.disconnectTimers.delete(playerId);
      }

      if (roomManager.disconnectDebounceTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
        roomManager.disconnectDebounceTimers.delete(playerId);
      }

      // 不要把 identify/getReconnectInfo 当成“重连回来了”。
      // 只有在收到明确的回房间/回会话指令时才恢复isConnected并广播。
      const isExplicitRejoin = message.type === 'rejoinGameSession' || message.type === 'rejoinRoom' || message.type === 'join_room';

      if (isExplicitRejoin) {
        if (message.type === 'rejoinGameSession') {
          // 仅更新连接引用，状态恢复由 handleRejoinGameSession 显式触发，
          // 以便正确检测 wasDisconnected 并发送归来广播。
          const gameSession = roomManager.getPlayerGameSession(playerId);
          if (gameSession) {
            const player = gameSession.players.get(playerId);
            if (player) {
              player.ws = ws;
            }
          }

          roomManager.setPlayerConnection(playerId, ws);
          handleMessage(ws, playerId, message);
          return;
        }

        const gameSession = roomManager.getPlayerGameSession(playerId);
        if (gameSession) {
          const player = gameSession.players.get(playerId);
          if (player) {
            player.ws = ws;
            // 不要在这里设置 isConnected = true，交给业务处理器处理
            roomManager.setPlayerConnection(playerId, ws);
          }
        } else {
          const room = roomManager.getPlayerRoom(playerId);
          if (room) {
            const player = room.players.get(playerId);
            if (player) {
              player.ws = ws;
              // 不要在这里设置 isConnected = true，交给业务处理器处理
              roomManager.setPlayerConnection(playerId, ws);
              console.log(`玩家 ${playerId} WebSocket 已连接，等待业务重连确认...`);
            }
          } else {
            roomManager.setPlayerConnection(playerId, ws);
          }
        }
      } else {
        // 非重连场景（identify/ping等）：如果玩家在游戏会话或房间中，新连接说明是页面跳转完成或重连，
        // 立即注册新WS并取消旧WS的断线去抖定时器，防止1500ms去抖在rejoinGameSession到达前就触发。
        const inGameSession = !!roomManager.getPlayerGameSession(playerId);
        const inRoom = !!roomManager.getPlayerRoom(playerId);
        if (inGameSession || inRoom) {
          roomManager.setPlayerConnection(playerId, ws);
          if (roomManager.disconnectDebounceTimers.has(playerId)) {
            clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
            roomManager.disconnectDebounceTimers.delete(playerId);
            console.log(`玩家 ${playerId} 新WS连接（${inGameSession ? '游戏会话' : '房间'}），取消断线去抖定时器`);
          }
        } else {
          roomManager.setPlayerConnection(playerId, ws);
        }
      }

      handleMessage(ws, playerId, message);
    } catch (error) {
      console.error('消息解析错误:', error);
      ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' }));
    }
  });

  ws.on('close', () => {
    console.log(`玩家 ${playerId} 断开连接`);

    if (!playerId) return;

    if (roomManager.disconnectDebounceTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
      roomManager.disconnectDebounceTimers.delete(playerId);
    }

    // 连接切换去抖：页面跳转/短暂网络抖动时，客户端可能会迅速建立新连接。
    const debounceMs = 1500;
    const debounceTimer = setTimeout(() => {
      roomManager.disconnectDebounceTimers.delete(playerId);

      const currentWs = roomManager.getPlayerConnection(playerId);
      const switchedConnection = !!(currentWs && currentWs !== ws);

      if (!switchedConnection) {
        roomManager.playerConnections.delete(playerId);
      }

      if (roomManager.disconnectTimers.has(playerId)) {
        clearTimeout(roomManager.disconnectTimers.get(playerId));
        roomManager.disconnectTimers.delete(playerId);
      }

      // 如果玩家已经有了新的WebSocket连接（例如从房间页跳转到游戏页），
      if (switchedConnection) {
        console.log(`玩家 ${playerId} WebSocket 连接已切换到新连接，跳过断线处理`);
        return;
      }

      const roomCode = roomManager.playerRooms.get(playerId);
      const room = roomCode ? roomManager.getRoom(roomCode) : null;
      const gameSession = roomManager.getPlayerGameSession(playerId);

      if (room && room.gameState !== 'playing' && !gameSession) {
        const disconnectTimeout = 10000;
        console.log(`玩家 ${playerId} 在房间配置阶段断开，标记为离线，${disconnectTimeout / 1000}秒后移除`);

        const player = room.players.get(playerId);
        if (player) {
          player.isConnected = false;
          player.disconnectedAt = Date.now();
        }

        room.broadcast({
          type: 'playerDisconnected',
          playerId,
          room: room.toJSON()
        });

        const timer = setTimeout(() => {
          console.log(`玩家 ${playerId} 重连超时，执行移除`);
          const currentPlayer = room.players.get(playerId);
          if (currentPlayer && !currentPlayer.isConnected) {
            room.removePlayer(playerId);
            roomManager.playerRooms.delete(playerId);

            if (room.players.size > 0) {
              // 如果房间中已经没有任何人类玩家（只剩AI），直接走房间销毁流程
              if (!room.hasHumanPlayers()) {
                console.log(`房间 ${roomCode} 仅剩AI玩家，立即销毁`);
                roomManager.immediateDestroyRoom(roomCode);
              } else {
                room.broadcast({
                  type: 'playerLeft',
                  playerId,
                  room: room.toJSON()
                });
              }
            } else {
              console.log(`房间 ${roomCode} 已无玩家，立即销毁`);
              roomManager.immediateDestroyRoom(roomCode);
            }
          }
          roomManager.disconnectTimers.delete(playerId);
        }, disconnectTimeout);
        roomManager.disconnectTimers.set(playerId, timer);
        return;
      }

      handlePlayerDisconnect(playerId);
    }, debounceMs);

    roomManager.disconnectDebounceTimers.set(playerId, debounceTimer);
  });
});

// 收包时统一消息封装：大厅走嵌套 data，对局走平铺，历史上两套并存。
// 在此一次性拍平，后续所有 handler 只按顶层字段读取，不再各自兼容。
function normalizeInboundMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const payload = message.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return message;
  const { data, ...envelope } = message;
  return { ...envelope, ...payload, type: envelope.type };
}

function handleMessage(ws, playerId, message) {
  // 心跳一来一回很频繁，不写日志，免得把真正有用的消息淹掉
  if (message.type !== 'ping') {
    console.log(`处理消息类型: ${message.type}, 玩家: ${playerId}`);
  }
  try {
    // 棋面已由服务端接管后，旧协议里"客户端上报棋面"的消息一律不再受理，
    // 否则客户端可以绕过规则直接改写权威棋面。客户端应改发 intent。
    if (isLegacyBoardReport(message.type) && isAuthorityManaged(playerId)) {
      console.warn(`[权威棋面] 忽略旧协议消息 ${message.type}（玩家 ${playerId}）`);
      return;
    }
    switch (message.type) {
      case 'ping':
        try {
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now(),
            playerId
          }));
        } catch (e) {
          // ignore
        }
        break;
      case 'pong':
        // 客户端可能会主动回传pong，服务器无需处理
        break;
      case 'identify':
        console.log(`玩家 ${playerId} 身份确认`);
        break;
      case 'getReconnectInfo':
        handleGetReconnectInfo(ws, playerId);
        break;
      case 'createRoom':
        handleCreateRoom(ws, playerId, message);
        break;
      case 'join_room':
        handleJoinRoom(ws, playerId, message);
        break;
      case 'spectate_room':
        handleSpectateRoom(ws, playerId, message);
        break;
      case 'listRooms':
        handleListRooms(ws);
        break;
      case 'leaveRoom':
      case 'leave_room':
        handleLeaveRoom(ws, playerId, message);
        break;
      case 'select_color':
        handleSelectColor(ws, playerId, message);
        break;
      case 'update_nickname':
        handleUpdateNickname(ws, playerId, message);
        break;
      case 'update_emoji':
        handleUpdateEmoji(ws, playerId, message);
        break;
      case 'teleportIcon':
      case 'diceReset':
        relayDisplay(message.type, playerId, message);
        break;
      case 'progressBarStart':
        handleProgressBarStart(ws, playerId, message);
        break;
      case 'rejoinRoom':
        handleRejoinRoom(ws, playerId, message);
        break;
      case 'rejoinGameSession':
        handleRejoinGameSession(ws, playerId, message);
        break;
      case 'intent':
        handleIntent(ws, playerId, message);
        break;
      case 'animationDone':
        handleAnimationDone(ws, playerId, message);
        break;
      case 'visibilityChange':
        // 前端报前后台：后台页面的动画会被节流，改成不等它演完
        if (message.hidden) backgroundPlayers.add(playerId);
        else backgroundPlayers.delete(playerId);
        break;
      case 'snapshotRequest':
        handleSnapshotRequest(ws, playerId);
        break;
      case 'updatePlayer':
        handleUpdatePlayer(ws, playerId, message);
        break;
      case 'updateSettings':
        handleUpdateSettings(ws, playerId, message);
        break;
      case 'update_room_name':
        handleUpdateRoomName(ws, playerId, message);
        break;
      case 'update_room_privacy':
        handleUpdateRoomPrivacy(ws, playerId, message);
        break;
      case 'returnToRoom':
        handleReturnToRoom(ws, playerId, message);
        break;
      case 'toggle_ready':
        handleToggleReady(ws, playerId, message);
        break;
      case 'start_game':
      case 'startGame':
        handleStartGame(ws, playerId);
        break;
      case 'add_ai_player':
        handleAddAIPlayer(ws, playerId, message);
        break;
      case 'remove_ai_player':
        handleRemoveAIPlayer(ws, playerId, message);
        break;
      case 'update_ai_difficulty':
        handleUpdateAIDifficulty(ws, playerId, message);
        break;
      case 'kickPlayer':
        handleKickPlayer(ws, playerId, message);
        break;
      case 'configure_piece_count':
        handleConfigurePieceCount(ws, playerId, message);
        break;
      case 'aiTakeoverChange':
        handleAITakeoverChange(ws, playerId, message);
        break;
      case 'audioEnabledChange':
        handleAudioEnabledChange(ws, playerId, message);
        break;
      case 'nicknameChange':
        handleNicknameChange(ws, playerId, message);
        break;
      case 'gameEnd':
        handleGameEnd(ws, playerId, message);
        break;
      case 'forceSettlement':
        handleForceSettlement(ws, playerId, message);
        break;
      case 'gamePause':
        handleGamePause(ws, playerId, message);
        break;
      case 'gameResume':
        handleGameResume(ws, playerId, message);
        break;
      case 'gameInfo':
        handleGameInfo(ws, playerId, message);
        break;
      case 'audioLoaded':
        handleAudioLoaded(ws, playerId, message);
        break;
      case 'chatMessage':
        handleChatMessage(ws, playerId, message);
        break;
      default:
        console.log(`未知消息类型: ${message.type}`);
        ws.send(JSON.stringify({ type: 'error', message: `未知消息类型: ${message.type}` }));
    }
  } catch (error) {
    console.error('处理消息错误:', error);
    ws.send(JSON.stringify({ type: 'error', message: error.message }));
  }
}

// ...

function handleGetReconnectInfo(ws, playerId) {
  try {
    // 优先：游戏会话（游戏进行中断线）
    const gameSession = roomManager.getPlayerGameSession(playerId);
    if (gameSession && gameSession.roomCode) {
      const room = roomManager.getRoom(gameSession.roomCode);
      const sessionPlayer = gameSession.players ? gameSession.players.get(playerId) : null;
      
      const canReconnect = !!(
        room && 
        sessionPlayer && 
        sessionPlayer.isConnected === false &&
        gameSession.players.has(playerId)
      );
      console.log(`[重连信息] player=${playerId} sessionFound=true isConnected=${sessionPlayer?.isConnected} canReconnect=${canReconnect} roomCode=${gameSession.roomCode}`);
      
      ws.send(JSON.stringify({
        type: 'reconnectInfo',
        canReconnect,
        roomCode: canReconnect ? gameSession.roomCode : null,
        source: 'gameSession'
      }));
      return;
    }

    // 其次：房间配置阶段断线
    const room = roomManager.getPlayerRoom(playerId);
    if (room) {
      const roomPlayer = room.players ? room.players.get(playerId) : null;
      
      const canReconnect = !!(
        roomPlayer && 
        roomPlayer.isConnected === false &&
        room.players.has(playerId)
      );
      console.log(`[重连信息] player=${playerId} roomFound=true isConnected=${roomPlayer?.isConnected} canReconnect=${canReconnect} roomCode=${room.code}`);
      
      ws.send(JSON.stringify({
        type: 'reconnectInfo',
        canReconnect,
        roomCode: canReconnect ? room.code : null,
        source: 'room'
      }));
      return;
    }

    console.log(`[重连信息] player=${playerId} 未找到任何会话或房间`);
    ws.send(JSON.stringify({ type: 'reconnectInfo', canReconnect: false, roomCode: null }));
  } catch (error) {
    console.error('获取重连信息失败:', error);
    ws.send(JSON.stringify({ type: 'reconnectInfo', canReconnect: false, roomCode: null }));
  }
}

function handleListRooms(ws) {
  try {
    const rooms = roomManager.listPublicRooms();
    ws.send(JSON.stringify({ type: 'roomsList', rooms }));
  } catch (error) {
    console.error('获取房间列表失败:', error);
    ws.send(JSON.stringify({ type: 'error', message: '获取房间列表失败' }));
  }
}

function handleCreateRoom(ws, playerId, message) {
  // 检查玩家是否在其他房间中
  const existingRoom = roomManager.getPlayerRoom(playerId);
  if (existingRoom) {
    console.log(`[迁移] 玩家 ${playerId} 已在房间 ${existingRoom.code} 中，执行静默物理分离以创建新房间`);
    
    // 直接执行底层静默清理
    forceDetachPlayerFromExistingContexts(playerId, null, true);
  }

  // 确保没有任何残留上下文
  forceDetachPlayerFromExistingContexts(playerId, null, true);

  const emoji = message.emoji;
  const player = new Player(playerId, ws, message.nickname, emoji);
  const room = roomManager.createRoom(player);
  ws.send(JSON.stringify({ type: 'roomCreated', room: room.toJSON() }));

  // 每日统计：记录创建房间
  dailyStats.recordRoomCreated();
}

function handleJoinRoom(ws, playerId, message) {
  const roomCode = message.roomCode;
  const room = roomManager.getRoom(roomCode);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不存在或已被销毁' }));
    return;
  }

  // 检查玩家是否已经在该房间中，或者在当前房间的游戏会话中（硬离开后尝试回来）
  const gameSession = roomManager.getPlayerGameSession(playerId);
  const isInSession = !!(gameSession && gameSession.roomCode === roomCode && gameSession.players.has(playerId));

  if (room.players.has(playerId) || isInSession) {
    // 如果不在房间但在会话中，说明是之前“硬离开”后又想重连，需先恢复房间成员身份
    if (!room.players.has(playerId) && isInSession) {
      console.log(`玩家 ${playerId} 正在重回游戏中房间 ${roomCode} (从游戏会话恢复)`);
      const sessionPlayer = gameSession.players.get(playerId);
      const player = new Player(playerId, ws, sessionPlayer.nickname, sessionPlayer.emoji);
      player.color = sessionPlayer.color;
      player.isHost = sessionPlayer.isHost;

      // 重新加入房间映射
      room.players.set(playerId, player);
      roomManager.playerRooms.set(playerId, roomCode);
    }

    const existingPlayer = room.players.get(playerId);

    // 清除断开连接定时器（如果有）
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
      console.log(`玩家 ${playerId} 重新加入房间 ${roomCode}，清除断开定时器`);
    }

    // 恢复连接
    existingPlayer.ws = ws;
    existingPlayer.isConnected = true;
    existingPlayer.disconnectedAt = null;

    // 重新关联房间/连接映射
    roomManager.playerRooms.set(playerId, roomCode);
    roomManager.setPlayerConnection(playerId, ws);

    // 只有客户端显式传了 nickname/emoji 才更新（避免用 undefined/空值覆盖）
    if (Object.prototype.hasOwnProperty.call(message, 'nickname')) {
      const nicknameStr = (message.nickname == null ? '' : String(message.nickname));
      const trimmed = nicknameStr.trim();
      if (trimmed) {
        existingPlayer.nickname = trimmed;
      }
    }
    if (Object.prototype.hasOwnProperty.call(message, 'emoji')) {
      if (message.emoji != null) {
        existingPlayer.emoji = message.emoji;
      }
    }

    // 发送加入成功消息（如果游戏正在进行，补齐gameData以支持重连跳转）
    const response = { type: 'roomJoined', room: room.toJSON() };
    if (room.gameState === 'playing' && room.gameSessionId) {
      const gameSession = roomManager.getGameSession(room.gameSessionId);
      if (gameSession && gameSession.gameData) {
        response.gameData = gameSession.gameData;
      } else {
        response.gameData = { gameSessionId: room.gameSessionId };
      }
    }
    ws.send(JSON.stringify(response));

    // 广播重连消息给其他玩家
    room.broadcast({
      type: 'playerReconnected',
      playerId,
      room: room.toJSON()
    }, playerId);
    console.log(`玩家 ${playerId} 重新加入房间 ${roomCode}，广播 playerReconnected`);
    return;
  }
  // 房间满员：计算已占用席位 = 真实玩家 + AI 玩家
  const aiCount = room.settings?.aiPlayers ? room.settings.aiPlayers.length : 0;
  const totalPlayerCount = room.players.size + aiCount;
  if (totalPlayerCount >= 4) {
    ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
    return;
  }

  // 检查玩家是否在其他房间中（非当前要加入的房间）
  const existingRoom = roomManager.getPlayerRoom(playerId);
  if (existingRoom && existingRoom.code !== roomCode) {
    console.log(`[迁移] 玩家 ${playerId} 已在房间 ${existingRoom.code} 中，执行静默物理分离以加入 ${roomCode}`);
    
    // 直接执行底层静默清理
    forceDetachPlayerFromExistingContexts(playerId, roomCode, true);
  }

  // 再次确保没有任何残留上下文（针对可能存在的残留 Session）
  forceDetachPlayerFromExistingContexts(playerId, roomCode, true);

  const player = new Player(playerId, ws, message.nickname, message.emoji);
  roomManager.joinRoom(roomCode, player);

  // 发送加入成功消息
  const response = { type: 'roomJoined', room: room.toJSON() };
  if (room.gameState === 'playing' && room.gameSessionId) {
    // 如果游戏正在进行，发送完整的游戏会话数据（包括defeatCounts等）
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.gameData) {
      response.gameData = gameSession.gameData;
      console.log(`发送游戏数据给重连玩家 ${playerId}，包含击败计数:`, gameSession.gameData.defeatCounts);
    } else {
      // 后备方案：只发送gameSessionId
      response.gameData = { gameSessionId: room.gameSessionId };
    }
  }
  ws.send(JSON.stringify(response));

  // 广播玩家加入
  room.broadcast({
    type: 'playerJoined',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  }, playerId); // 排除当前玩家
}

function handleSpectateRoom(ws, playerId, message) {
  const roomCode = message.roomCode;
  const room = roomManager.getRoom(roomCode);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不存在或已被销毁' }));
    return;
  }

  // 如果观战者本身就是游戏中的玩家，转为重连而非观战
  if (room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.players.has(playerId)) {
      console.log(`[观战→重连] 玩家 ${playerId} 试图观战自己的游戏，转为重连处理`);
      roomManager.setPlayerConnection(playerId, ws);
      const player = gameSession.players.get(playerId);
      if (player) {
        player.ws = ws;
      }
      const response = {
        type: 'spectateJoined',
        room: room.toJSON(),
        gameData: gameSession.gameData,
        gameSessionId: room.gameSessionId,
        gameSession: gameSession.toJSON(),
        isReconnect: true
      };
      ws.send(JSON.stringify(response));
      sendSnapshotTo(ws, room.gameSessionId);
      console.log(`玩家 ${playerId} 已通过观战路径重连游戏`);
      return;
    }
  }

  // 正常观战者
  const MAX_SPECTATORS = 5;
  if (room.spectators.size >= MAX_SPECTATORS) {
    ws.send(JSON.stringify({ type: 'error', message: '观战人数已满' }));
    return;
  }

  roomManager.setPlayerConnection(playerId, ws);
  roomManager.playerSpectatingRooms.set(playerId, roomCode);
  room.spectators.add(playerId);
  room.spectatorNames.set(playerId, sanitizeText(message.nickname).trim() || spectatorDisplayName(playerId));

  if (room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession) {
      gameSession.spectators.add(playerId);
    }
  }

  // 发送加入观战成功消息
  const response = { type: 'spectateJoined', room: room.toJSON() };
  if (room.gameState === 'playing' && room.gameSessionId) {
    const gameSession = roomManager.getGameSession(room.gameSessionId);
    if (gameSession && gameSession.gameData) {
      response.gameData = gameSession.gameData;
      response.gameSessionId = room.gameSessionId;
      response.gameSession = gameSession.toJSON();
    }
  }
  ws.send(JSON.stringify(response));
  if (room.gameSessionId) sendSnapshotTo(ws, room.gameSessionId);
  console.log(`玩家 ${playerId} 开始观战房间 ${roomCode}`);
}

// 选择颜色：四个座位颜色固定，谁坐哪个座位就按哪个颜色参加回合轮转。
// 座位已被其他玩家占用时，两人交换座位，避免先后入房顺序把座位锁死。
const handleSelectColor = withRoomValidation((ws, playerId, message, room, player) => {
  const colorIndex = Number(message.colorIndex);
  if (![1, 2, 3, 4].includes(colorIndex)) {
    ws.send(JSON.stringify({ type: 'error', message: '无效的颜色' }));
    return;
  }

  // AI座位由房主通过AI配置增删，不参与玩家换座
  if (room.settings.aiPlayers.some(ai => ai.color === colorIndex)) {
    ws.send(JSON.stringify({ type: 'error', message: '该颜色已被AI玩家占用' }));
    return;
  }

  const occupant = Array.from(room.players.values())
    .find(p => p.color === colorIndex && p.id !== playerId);

  const previousColor = player.color;
  if (occupant) {
    // 换座要求本人原有座位有效，否则会让两人撞到同一个颜色
    if (![1, 2, 3, 4].includes(previousColor)) {
      ws.send(JSON.stringify({ type: 'error', message: '当前座位异常，无法换座' }));
      return;
    }
    occupant.color = previousColor;
  }
  player.color = colorIndex;

  room.broadcast({
    type: 'playerUpdated',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  });
});

// 玩家资料（昵称/表情）在游戏会话或房间两处都可能存在，统一走这条更新与广播路径
function applyPlayerProfileUpdate(playerId, mutate) {
  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (gameSession && gameSession.players.has(playerId)) {
    mutate(gameSession.players.get(playerId));
    const player = gameSession.players.get(playerId);
    gameSession.broadcast({
      type: 'playerUpdated',
      player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji }
    });
    return true;
  }

  const room = roomManager.getPlayerRoom(playerId);
  if (room) {
    const player = room.players.get(playerId);
    if (player) {
      mutate(player);
      room.broadcast({
        type: 'playerUpdated',
        player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
        room: room.toJSON()
      });
    }
    return true;
  }

  return false;
}

// 更新昵称（不使用房间验证中间件，允许玩家在房间外更新）
function handleUpdateNickname(ws, playerId, message) {
  try {
    const nickname = message.nickname;
    const manualInput = message.manualInput === true;
    // 确保nickname是字符串，如果为null/undefined则设置为空字符串
    const nicknameStr = (nickname == null ? '' : String(nickname));
    const nextNickname = manualInput ? sanitizeText(nicknameStr) : nicknameStr;
    const newNickname = nextNickname.trim() || getDefaultNickname(playerId);

    const updated = applyPlayerProfileUpdate(playerId, (player) => {
      // 房主昵称变化时，默认房名跟随更新（自定义房名不动）
      const room = roomManager.getPlayerRoom(playerId);
      if (room && room.host && room.host.id === playerId) {
        const oldDefaultRoomName = `${player.nickname}的房间`;
        if (room.name === oldDefaultRoomName || !room.name) {
          room.name = `${newNickname}的房间`;
        }
      }
      player.nickname = newNickname;
    });

    if (!updated) {
      console.log(`玩家 ${playerId} 更新昵称为 ${newNickname}（不在房间中）`);
    }
  } catch (error) {
    console.error('更新昵称失败:', error);
    ws.send(JSON.stringify({ type: 'error', message: '更新昵称失败' }));
  }
}

// 昵称变化只负责把显示名转发给同局其他人，权威昵称仍由 update_nickname 写入
function handleNicknameChange(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);

  // 房主可代理由其托管的玩家发起改名
  const targetPlayerId = message.playerId || playerId;
  const manualInput = message.manualInput === true;
  const rawNickname = message.nickname == null ? '' : String(message.nickname);
  const nextNickname = manualInput ? sanitizeText(rawNickname) : rawNickname;

  target.broadcast({
    type: 'nicknameChange',
    playerId: targetPlayerId,
    nickname: nextNickname,
    timestamp: message.timestamp
  });
}

function handleUpdateEmoji(ws, playerId, message) {
  try {
    const emoji = message.emoji;
    const updated = applyPlayerProfileUpdate(playerId, (player) => {
      player.emoji = emoji;
    });

    if (!updated) {
      console.log(`玩家 ${playerId} 更新emoji为 ${emoji}（不在房间中）`);
    }
  } catch (error) {
    console.error('更新表情失败:', error);
    ws.send(JSON.stringify({ type: 'error', message: '更新表情失败' }));
  }
}

const handleUpdateRoomName = withRoomValidation((ws, playerId, message, room) => {
  const name = message.name;
  const nameStr = (name == null ? '' : String(name));
  const newName = nameStr.trim();

  room.name = newName;

  room.broadcast({
    type: 'roomNameUpdated',
    name: room.name,
    room: room.toJSON()
  });
}, true);

const handleUpdateRoomPrivacy = withRoomValidation((ws, playerId, message, room) => {
  const isPrivate = !!message.isPrivate;
  room.isPrivate = isPrivate;
  room.broadcast({ type: 'roomPrivacyUpdated', isPrivate, room: room.toJSON() });
}, true);

const handleReturnToRoom = withRoomValidation((ws, playerId, message, room, player) => {
  // 游戏结束后：首次返回房间的玩家成为房主且自动准备；后续返回者不允许覆盖房主
  if (room.postGameHostId && room.postGameHostId !== playerId) {
    room.broadcast({
      type: 'roomReset',
      room: room.toJSON()
    });
    return;
  }

  room.gameState = 'waiting';
  room.gameSessionId = null;

  // 锁定首次返回房间的房主
  room.postGameHostId = playerId;

  // 切换房主为触发者
  room.host = player;
  for (const p of room.players.values()) {
    p.isHost = (p.id === playerId);
  }

  // 重置准备状态：新房主已准备，其余未准备
  room.playerReadyStatus = new Map();
  for (const p of room.players.values()) {
    room.playerReadyStatus.set(p.id, p.id === playerId);
  }

  room.broadcast({
    type: 'roomReset',
    room: room.toJSON()
  });
}, true);

// 踢出玩家（需要房主权限）
const handleKickPlayer = withRoomValidation((ws, playerId, message, room) => {
  const targetId = message.playerId;
  if (!targetId) throw new Error('缺少目标玩家ID');
  if (targetId === playerId) throw new Error('不能踢出自己');

  const targetPlayer = room.players.get(targetId);
  if (!targetPlayer) throw new Error('目标玩家不存在');

  if (room.gameState === 'playing') {
    throw new Error('游戏进行中，无法踢出玩家');
  }

  console.log(`[踢人] 房主 ${playerId} 准备踢出玩家 ${targetId} (${targetPlayer.nickname})`);

  // 向被踢玩家发送通知
  const targetWs = roomManager.getPlayerConnection(targetId);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'kicked',
      reason: 'host_kicked',
      message: '你已被房主踢出房间'
    }));
  }

  // 从房间移除玩家
  room.removePlayer(targetId);
  roomManager.playerRooms.delete(targetId);

  // 广播玩家被踢出的消息
  room.broadcast({
    type: 'playerLeft',
    playerId: targetId,
    reason: 'kicked',
    room: room.toJSON()
  });

  console.log(`[踢人] 房主 ${playerId} 已踢出玩家 ${targetId}`);
}, true);

function handleLeaveRoom(ws, playerId, message = {}, isSilentMigration = false) {
  // 处理观战者离开
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (room) {
      room.spectators.delete(playerId);
      room.spectatorNames.delete(playerId);
      if (room.gameSessionId) {
        const gameSession = roomManager.getGameSession(room.gameSessionId);
        if (gameSession) {
          gameSession.spectators.delete(playerId);
        }
      }
    }
    roomManager.playerSpectatingRooms.delete(playerId);
    return;
  }

  const roomCode = roomManager.playerRooms.get(playerId);
  if (!roomCode) return;

  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  // 如果是静默迁移（加入新房间时），跳过所有广播逻辑，仅清理映射
  if (isSilentMigration) {
    console.log(`[迁移] 玩家 ${playerId} 正在从旧房间 ${roomCode} 静默迁移到新房间，彻底拦截广播`);
    
    // 清除断线延迟定时器
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
    }

    // 从房间数据结构中彻底移除，不走任何广播逻辑
    room.removePlayer(playerId);
    roomManager.playerRooms.delete(playerId);
    
    // 如果玩家在游戏会话中，也仅做映射清理，不触发 handlePlayerDisconnect
    const gameSessionId = roomManager.playerSessions.get(playerId);
    if (gameSessionId) {
      const gameSession = roomManager.getGameSession(gameSessionId);
      if (gameSession && gameSession.players.has(playerId)) {
        const player = gameSession.players.get(playerId);
        player.isConnected = false;
        player.ws = null;
        player.disconnectedAt = player.disconnectedAt || Date.now();
        // 关键：不要在这里调用 gameSession.broadcast 或 handlePlayerDisconnect
      }
      roomManager.playerSessions.delete(playerId);
    }

    // 如果旧房间空了且没在游戏中，销毁
    if (room.players.size === 0 && room.gameState !== 'playing') {
      roomManager.rooms.delete(roomCode);
    }
    return;
  }

  // 检查是否是游戏结束后离开
  const isGameEnded = message.reason === 'game_ended';

  const leaveReason = message.reason;
  const isHardLeave = leaveReason === 'return_home' || leaveReason === 'quit_game' || leaveReason === 'user_quit_game';

  // 游戏进行中：leave_room 视为“软掉线/可重连离开”，不移除玩家、不销毁会话
  // 典型场景：玩家从游戏页返回主页/联机面板、刷新页面等
  if (room.gameState === 'playing' && !isGameEnded && !isHardLeave) {
    console.log(`玩家 ${playerId} 在游戏中发送leave_room，按掉线处理（保留重连资格）`);
    try {
      handlePlayerDisconnect(playerId);
    } catch (e) {
      console.error('处理游戏中leave_room为断线时出错:', e);
    }

    // 尝试给客户端一个确认（连接可能即将关闭，失败可忽略）
    try {
      ws.send(JSON.stringify({ type: 'roomLeft', soft: true }));
    } catch (err) {
      // ignore
    }
    return;
  }

  if (room.gameState === 'playing' && !isGameEnded && isHardLeave) {
    console.log(`玩家 ${playerId} 在游戏中发送leave_room(${leaveReason})，按主动退出处理（不保留重连资格）`);

    // 清除断线延迟定时器（玩家主动离开，无需等待）
    if (roomManager.disconnectTimers.has(playerId)) {
      clearTimeout(roomManager.disconnectTimers.get(playerId));
      roomManager.disconnectTimers.delete(playerId);
    }

    const gameSessionId = roomManager.playerSessions.get(playerId);
    const gameSession = gameSessionId ? roomManager.getGameSession(gameSessionId) : null;
    const leavingFromSession = !!(gameSession && gameSession.players && gameSession.players.has(playerId));

    let leavingPlayerSnapshot = null;
    if (leavingFromSession) {
      leavingPlayerSnapshot = gameSession.players.get(playerId);
    }

    // 从房间移除
    room.removePlayer(playerId);
    roomManager.playerRooms.delete(playerId);

    // 清理连接映射
    roomManager.playerConnections.delete(playerId);

    // 从会话处理
    if (leavingFromSession) {
      const wasHost = !!(leavingPlayerSnapshot && leavingPlayerSnapshot.isHost);
      const leavingColor = leavingPlayerSnapshot ? leavingPlayerSnapshot.color : null;

      // 不要从游戏会话中删除主动退出的玩家，而是将他们保留，仅标记为离线
      const sessionPlayer = gameSession.players.get(playerId);
      if (sessionPlayer) {
        sessionPlayer.isConnected = false;
        sessionPlayer.isHost = false;
        console.log(`玩家${playerId}主动退出游戏`);
      }

      // 房主转移
      if (wasHost) {
        let newHost = null;
        for (const [pId, p] of gameSession.players) {
          if (p && !p.isAI && p.isConnected) {
            newHost = p;
            break;
          }
        }

        if (!newHost) {
          for (const [pId, p] of gameSession.players) {
            if (p && !p.isAI) {
              newHost = p;
              break;
            }
          }
        }

        if (newHost) {
          for (const [pId, p] of gameSession.players) {
            if (p) p.isHost = (pId === newHost.id);
          }
          gameSession.hostId = newHost.id;

          const roomNewHost = room.players.get(newHost.id);
          if (roomNewHost) {
            room.host = roomNewHost;
            for (const p of room.players.values()) {
              if (p) p.isHost = (p.id === roomNewHost.id);
            }
          }

          recordHostChange(gameSession, newHost);
          gameSession.broadcast({
            type: 'hostChanged',
            oldHostId: playerId,
            newHostId: newHost.id,
            newHostNickname: newHost.nickname,
            gameSession: gameSession.toJSON(),
            timestamp: Date.now()
          });
        }
      }

      // 广播状态更新，前端会据此更新为AI状态
      gameSession.broadcast({
        type: 'playerUpdated',
        players: Array.from(gameSession.players.values()),
        timestamp: Date.now()
      });

      // 触发断开连接消息，确保前端UI表现一致（断开线标志等）
      const disconnectPlayers = Array.from(gameSession.players.values()).map(p => ({
        id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
        isHost: p.isHost || false, isConnected: false, isAI: p.isAI
      }));
      gameSession.broadcast({
        type: 'playerDisconnected',
        playerId,
        players: disconnectPlayers
      });
    }

    // 广播房间更新
    if (room.hasHumanPlayers()) {
      room.broadcast({ type: 'playerLeft', playerId, room: room.toJSON() });
    } else {
      console.log(`房间 ${roomCode} 已无人类玩家，立即销毁`);
      roomManager.immediateDestroyRoom(roomCode);
    }

    try {
      ws.send(JSON.stringify({ type: 'roomLeft' }));
    } catch (err) {
      // ignore
    }
    return;
  }

  // 清除断线延迟定时器（玩家主动离开，无需等待）
  if (roomManager.disconnectTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectTimers.get(playerId));
    roomManager.disconnectTimers.delete(playerId);
  }

  // 执行离开逻辑
  room.removePlayer(playerId);
  roomManager.playerRooms.delete(playerId);

  // 如果是游戏结束后离开，且房间已空，标记为已结算
  if (isGameEnded && room.players.size === 0 && room.gameState === 'playing') {
    console.log(`房间 ${roomCode} 游戏已结束，所有玩家已离开，标记为已结算`);
    room.gameState = 'finished';
  }

  // 立即广播离开消息（在发送确认之前，确保其他玩家立即收到）
  if (room.hasHumanPlayers()) {
    room.broadcast({ type: 'playerLeft', playerId, room: room.toJSON() });
  } else {
    // 如果没有人类玩家了（只剩AI或全空），立即销毁
    console.log(`房间 ${roomCode} 已无人类玩家，立即销毁`);
    roomManager.immediateDestroyRoom(roomCode);
  }

  // 发送离开确认（在广播之后）
  try {
    ws.send(JSON.stringify({ type: 'roomLeft' }));
  } catch (err) {
    console.log(`发送离开确认失败（连接可能已关闭）: ${err.message}`);
  }
}

function handleUpdatePlayer(ws, playerId, message) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room) throw new Error('玩家不在任何房间中');

  const player = room.players.get(playerId);
  if (!player) throw new Error('玩家不存在');

  // 更新玩家信息
  if (message.nickname !== undefined) {
    // 确保nickname是字符串，如果为null/undefined则设置为空字符串
    const nicknameStr = (message.nickname == null ? '' : String(message.nickname));
    player.nickname = nicknameStr.trim() || getDefaultNickname(playerId);
  }
  if (message.emoji !== undefined) {
    player.emoji = message.emoji;
  }
  if (message.color !== undefined) {
    player.color = message.color;
  }

  // 广播更新
  room.broadcast({
    type: 'playerUpdated',
    player: { id: player.id, nickname: player.nickname, color: player.color, emoji: player.emoji },
    room: room.toJSON()
  });
}

// 更新房间设置（需要房主权限）
const handleUpdateSettings = withRoomValidation((ws, playerId, message, room) => {
  room.updateSettings(message.settings);
  room.broadcast({ type: 'settingsUpdated', settings: room.settings, room: room.toJSON() });
}, true);

// 切换玩家准备状态
function handleToggleReady(ws, playerId, message) {
  try {
    const room = roomManager.getPlayerRoom(playerId);
    if (!room) throw new Error('玩家不在任何房间中');

    const player = room.players.get(playerId);
    if (!player) throw new Error('玩家不在房间中');

    // 房主自动准备，不需要手动切换
    if (player.isHost) {
      return;
    }

    // 更新准备状态
    const isReady = message.isReady ?? false;
    room.playerReadyStatus.set(playerId, isReady);

    console.log(`玩家 ${playerId} 准备状态更新为: ${isReady}`);

    // 广播准备状态变化
    room.broadcast({
      type: 'playerReadyStatusChanged',
      playerId: playerId,
      isReady: isReady
    });
  } catch (error) {
    console.error('切换准备状态失败:', error);
    ws.send(JSON.stringify({ type: 'error', message: error.message }));
  }
}

function handleStartGame(ws, playerId) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room) throw new Error('玩家不在任何房间中');
  if (room.gameState === 'playing') throw new Error('游戏已经开始');
  if (room.players.size < 2) throw new Error('至少需要2名玩家才能开始游戏');

  // 开始新一局时，清除结算返回房主锁定
  room.postGameHostId = null;

  // 开始新一局时，重置所有真实玩家的AI托管状态（避免上一局/异常超时遗留导致开局即托管）
  for (const p of room.players.values()) {
    if (p && !p.isAI) {
      p.isAITakeover = false;
    }
  }

  // 检查所有非房主玩家是否都准备
  for (const [pId, player] of room.players.entries()) {
    if (!player.isHost) {
      const isReady = room.playerReadyStatus.get(pId) || false;
      if (!isReady) {
        throw new Error('请等待所有玩家准备');
      }
    }
  }

  // 更新房间状态
  if (room.gameSessionId) {
    console.log(`房间 ${room.code} 开启新游戏，立即清理旧会话: ${room.gameSessionId}`);
    roomManager.removeGameSession(room.gameSessionId);
  }

  room.gameState = 'playing';
  const gameSessionId = roomManager.generateGameSessionId();
  room.gameSessionId = gameSessionId;

  // 收集玩家（真实+AI），设置房主标志
  const realPlayers = Array.from(room.players.values()).map(p => ({
    id: p.id,
    color: p.color,
    playerNumber: p.color,  // 玩家编号等于颜色编号（1-4）
    nickname: p.nickname,
    emoji: p.emoji,
    isAI: false,
    isAITakeover: false,
    // 沿用房间上记录的音效偏好，保证换局后仍能恢复
    audioEnabled: p.audioEnabled,
    isHost: p.id === room.host.id  // 设置房主标志
  }));
  const aiPlayers = room.settings.aiPlayers.map(ai => ({
    id: ai.color,
    color: ai.color,
    playerNumber: ai.color,  // 玩家编号等于颜色编号（1-4）
    nickname: ai.nickname,
    emoji: ai.emoji || 'bot',
    isAI: true,
    difficulty: ai.difficulty || 'easy',
    isHost: false  // AI玩家不是房主
  }));
  const allPlayers = [...realPlayers, ...aiPlayers];

  // 创建游戏会话
  const hostPlayer = realPlayers.find(p => p.isHost);
  const gameSession = roomManager.createGameSession(
    gameSessionId,
    allPlayers,
    room.settings.pieceCount,
    room.code,
    hostPlayer ? hostPlayer.id : null,
    room.settings.skillMode,
    room.settings.happyMode
  );

  // 继承房间内的观战者
  if (room.spectators) {
    room.spectators.forEach(s => gameSession.spectators.add(s));
  }

  console.log('游戏会话创建完成，房主:', realPlayers.find(p => p.isHost)?.id);

  // 设置初始当前玩家（颜色最小的玩家）
  const sortedPlayers = allPlayers.sort((a, b) => a.color - b.color);
  const firstPlayer = sortedPlayers[0].color;
  gameSession.gameData.currentPlayer = firstPlayer;
  gameSession.gameData.gamePhase = 'rolling';
  console.log(`游戏开始，设置初始当前玩家: ${firstPlayer}`);

  // 建立连接映射
  realPlayers.forEach(player => {
    roomManager.setPlayerConnection(player.id, roomManager.getPlayerConnection(player.id) || ws);
  });

  // 设置强制加载超时，防止有人掉线导致全部卡在加载页
  setTimeout(() => {
    const currentSession = roomManager.getGameSession(gameSessionId);
    if (currentSession) {
      const realCount = Array.from(currentSession.players.values()).filter(p => !p.isAI).length;
      if (currentSession.audioLoadedPlayers.size < realCount) {
        console.log(`[音频加载] 游戏会话 ${gameSessionId} 强制超时，发送 allAudioLoaded`);
        // 补充所有真实玩家到已加载列表，避免后续重连判定出错
        for (const [pId, p] of currentSession.players) {
          if (!p.isAI) currentSession.audioLoadedPlayers.add(pId);
        }
        currentSession.broadcast({ type: 'allAudioLoaded', gameSessionId });
      }
    }
  }, 15000);

  // 广播游戏开始
  room.broadcast({
    type: 'gameStarted',
    gameSessionId,
    pieceCount: room.settings.pieceCount,
    skillMode: room.settings.skillMode || false,
    happyMode: room.settings.happyMode || false,
    room: room.toJSON()
  });

  // 交给服务端权威层接管棋面：此后骰子与位置由服务端计算
  startAuthoritySession(gameSession).catch(error => {
    console.error(`[权威棋面] 会话 ${gameSessionId} 初始化失败:`, error);
  });

  // 每日统计：记录游戏开始
  dailyStats.recordGameStarted();
}

// 添加AI玩家（需要房主权限）
const handleAddAIPlayer = withRoomValidation((ws, playerId, message, room) => {
  const { colorIndex, difficulty } = message;
  const usedColors = [...Array.from(room.players.values()).map(p => p.color), ...room.settings.aiPlayers.map(ai => ai.color)];
  if (usedColors.includes(colorIndex)) throw new Error('该颜色已被占用');

  // 生成AI玩家名称（与前端逻辑一致）
  const easyBots = [];
  const hardBots = [];

  // 包含当前要添加的AI玩家
  const allAIPlayers = [...room.settings.aiPlayers, { color: colorIndex, difficulty: difficulty || 'easy' }];

  allAIPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      hardBots.push(ai.color);
    } else {
      easyBots.push(ai.color);
    }
  });

  easyBots.sort((a, b) => a - b);
  hardBots.sort((a, b) => a - b);

  let botName;
  const aiDifficulty = difficulty || 'easy';

  if (aiDifficulty === 'hard') {
    const indexInHard = hardBots.indexOf(colorIndex) + 1;
    botName = `AI-${indexInHard}`;
  } else {
    const indexInEasy = easyBots.indexOf(colorIndex) + 1;
    botName = `Bot-${indexInEasy}`;
  }

  const aiPlayer = {
    color: colorIndex,
    difficulty: aiDifficulty,
    nickname: botName,
    emoji: 'bot'
  };
  room.settings.aiPlayers.push(aiPlayer);

  // 广播AI添加
  room.broadcast({ type: 'aiPlayerAdded', aiPlayer, room: room.toJSON() });
}, true);

// 移除AI玩家（需要房主权限）
const handleRemoveAIPlayer = withRoomValidation((ws, playerId, message, room) => {
  const { colorIndex } = message;
  const aiIndex = room.settings.aiPlayers.findIndex(ai => ai.color === colorIndex);
  if (aiIndex === -1) throw new Error('AI玩家不存在');

  room.settings.aiPlayers.splice(aiIndex, 1);

  // 重新编号剩余 AI 玩家的昵称
  const remainingAI = room.settings.aiPlayers;
  const easyBots = remainingAI.filter(ai => ai.difficulty === 'easy').sort((a, b) => a.color - b.color);
  const hardBots = remainingAI.filter(ai => ai.difficulty === 'hard').sort((a, b) => a.color - b.color);

  remainingAI.forEach(ai => {
    if (ai.difficulty === 'hard') {
      const indexInHard = hardBots.indexOf(ai) + 1;
      ai.nickname = `AI-${indexInHard}`;
    } else {
      const indexInEasy = easyBots.indexOf(ai) + 1;
      ai.nickname = `Bot-${indexInEasy}`;
    }
  });

  // 广播AI移除
  room.broadcast({ type: 'aiPlayerRemoved', colorIndex, room: room.toJSON() });
}, true);

// 更新AI难度（需要房主权限）
const handleUpdateAIDifficulty = withRoomValidation((ws, playerId, message, room) => {
  const { colorIndex, difficulty } = message;
  const aiPlayer = room.settings.aiPlayers.find(ai => ai.color === colorIndex);
  if (!aiPlayer) throw new Error('AI玩家不存在');

  // 更新难度
  aiPlayer.difficulty = difficulty;

  // 按难度分类所有AI玩家
  const easyBots = [];
  const hardBots = [];

  room.settings.aiPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      hardBots.push(ai.color);
    } else {
      easyBots.push(ai.color);
    }
  });

  // 按颜色排序
  easyBots.sort((a, b) => a - b);
  hardBots.sort((a, b) => a - b);

  // 重新计算所有AI玩家的昵称
  room.settings.aiPlayers.forEach(ai => {
    if (ai.difficulty === 'hard') {
      const indexInHard = hardBots.indexOf(ai.color) + 1;
      ai.nickname = `AI-${indexInHard}`;
    } else {
      const indexInEasy = easyBots.indexOf(ai.color) + 1;
      ai.nickname = `Bot-${indexInEasy}`;
    }
  });

  console.log(`所有AI玩家昵称已更新:`, room.settings.aiPlayers.map(ai => `${ai.nickname}(颜色${ai.color},难度${ai.difficulty})`));

  // 广播难度更新（包含所有AI玩家的最新数据）
  room.broadcast({ type: 'aiDifficultyUpdated', colorIndex, difficulty, room: room.toJSON() });
}, true);

// 掷骰子（使用通用广播目标）

// 展示类消息只是把发送者的表现转发给同局其他人，字段直接透传，不需服务端裁决
const DISPLAY_RELAYS = {
  teleportIcon: [], // 只是「有人开了传送门」的信号，图标显隐由快照裁决
  progressBarStart: [],
  diceReset: []
};

function relayDisplay(type, playerId, message) {
  const target = requireBroadcastTarget(playerId);

  const payload = { type, playerId };
  for (const field of DISPLAY_RELAYS[type]) payload[field] = message[field];
  payload.timestamp = message.timestamp;
  target.broadcast(payload);
}

function handleProgressBarStart(ws, playerId, message) {
  // 只转发显示；思考窗口由服务端维护（见 mirrorSnapshot），
  // 收客户端上报的时间等于把「本回合还剩多久」交给客户端自己说了算
  relayDisplay('progressBarStart', playerId, message);
}

function handleRejoinRoom(ws, playerId, message) {
  const roomCode = message.roomCode;
  const isReady = message.isReady;

  const room = roomManager.getRoom(roomCode);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
    return;
  }

  // 检查玩家是否在房间中，如果不在但在游戏会话中，执行自动恢复
  let player = room.players.get(playerId);
  if (!player) {
    const gameSession = roomManager.getPlayerGameSession(playerId);
    if (gameSession && gameSession.roomCode === roomCode && gameSession.players.has(playerId)) {
      console.log(`玩家 ${playerId} 正在重回房间 ${roomCode} (通过 rejoinRoom 从会话恢复)`);
      const sessionPlayer = gameSession.players.get(playerId);
      player = new Player(playerId, ws, sessionPlayer.nickname, sessionPlayer.emoji);
      player.color = sessionPlayer.color;
      player.isHost = sessionPlayer.isHost;

      room.players.set(playerId, player);
      roomManager.playerRooms.set(playerId, roomCode);
    } else {
      ws.send(JSON.stringify({ type: 'error', message: '您不在该房间中' }));
      return;
    }
  }

  // 清除断开连接定时器（如果有）
  if (roomManager.disconnectTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectTimers.get(playerId));
    roomManager.disconnectTimers.delete(playerId);
    console.log(`玩家 ${playerId} 重连，清除断开定时器`);
  }

  // 恢复玩家在线状态
  const wasDisconnected = !player.isConnected;
  player.isConnected = true;
  player.ws = ws;
  player.disconnectedAt = null;

  // 重新关联房间
  roomManager.playerRooms.set(playerId, roomCode);
  roomManager.setPlayerConnection(playerId, ws);

  // 更新准备状态（如果客户端提供了）
  if (typeof isReady === 'boolean') {
    room.playerReadyStatus.set(playerId, isReady);
  }

  // 发送重连成功消息给当前玩家
  ws.send(JSON.stringify({
    type: 'roomRejoined',
    playerId,
    roomCode,
    room: room.toJSON()
  }));

  // 如果之前是离线状态，广播重连消息给房间内其他玩家
  if (wasDisconnected) {
    console.log(`玩家 ${playerId} 重连成功，广播给房间内其他玩家`);
    room.broadcast({
      type: 'playerReconnected',
      playerId,
      room: room.toJSON()
    }, playerId); // 排除当前玩家

    // 广播“回来了”系统消息（排除本人）
    broadcastSystemChat(room, `${player.nickname}回来了`, playerId);
  }
}

function handleRejoinGameSession(ws, playerId, message) {
  const gameSessionId = message.gameSessionId;
  const gameSession = roomManager.getGameSession(gameSessionId);
  if (!gameSession) {
    ws.send(JSON.stringify({ type: 'error', message: '游戏会话不存在' }));
    return;
  }

  if (!gameSession.players.has(playerId)) {
    ws.send(JSON.stringify({ type: 'error', message: '您不在该游戏会话中' }));
    return;
  }

  // 重新进对局页面：从现在起这台要参与「等演完」，离开/断开时清掉
  markGamePage(playerId);

  // 重连冷却限制：防止玩家通过频繁刷新页面干扰其他玩家游戏流程
  // 2秒内多次重连跳过非必要的重复处理，但连接状态（ws、isConnected、disconnectedAt）必须更新
  if (!roomManager.rejoinCooldowns) roomManager.rejoinCooldowns = new Map();
  const now = Date.now();
  const lastRejoin = roomManager.getRejoinCooldown(playerId);
  if (now - lastRejoin < 2000) {
    console.log(`玩家 ${playerId} 重连过于频繁（${now - lastRejoin}ms内），跳过完整重连处理`);

    // 基础连接状态必须更新，防止断线定时器误判
    const player = gameSession.players.get(playerId);
    if (player) {
      player.isConnected = true;
      player.ws = ws;
      player.disconnectedAt = null;

      // 同步更新 roomManager 的连接引用（否则 boardSyncData 无法转发）
      roomManager.setPlayerConnection(playerId, ws);
      roomManager.playerSessions.set(playerId, gameSessionId);

      // 同步更新房间引用
      if (gameSession.roomCode) {
        const room = roomManager.getRoom(gameSession.roomCode);
        if (room) {
          const roomPlayer = room.players.get(playerId);
          if (roomPlayer) {
            roomPlayer.isConnected = true;
            roomPlayer.ws = ws;
            delete roomPlayer.disconnectedAt;
          }
        }
      }

      // 取消断线去抖定时器（如果有）
      roomManager.clearPlayerTimers(playerId);
    }

    // 广播给其他玩家：该玩家已重连
    gameSession.broadcast({
      type: 'playerReconnected',
      playerId,
      timestamp: Date.now()
    });

    // 仍然发送最新游戏数据给重连玩家
    ws.send(JSON.stringify({ type: 'gameSessionConnected', playerId, gameSessionId, gameSession: gameSession.toJSON() }));
    sendSnapshotTo(ws, gameSessionId);
    if (message.needsHistory) {
      sendGameInfoHistoryTo(ws, gameSession);
    }

    return;
  }
  roomManager.markRejoin(playerId, now);

  // 重新关联会话
  roomManager.playerSessions.set(playerId, gameSessionId);
  roomManager.setPlayerConnection(playerId, ws);

  // 取消旧 WS 的断线去抖定时器（页面跳转场景：旧 WS close → 新 WS rejoin）
  if (roomManager.disconnectDebounceTimers.has(playerId)) {
    clearTimeout(roomManager.disconnectDebounceTimers.get(playerId));
    roomManager.disconnectDebounceTimers.delete(playerId);
    console.log(`玩家 ${playerId} 重新加入游戏会话，取消断线去抖定时器`);
  }

  const player = gameSession.players.get(playerId);
  let wasDisconnected = false;
  let disconnectDuration = 0;

  if (player) {
    // 在发送 gameSessionConnected 之前先恢复状态
    // 这样 toJSON() 返回的数据中 isConnected 就是正确的 true，解决“加载不出数据”的问题
    wasDisconnected = !player.isConnected || !!player.disconnectedAt;
    disconnectDuration = player.disconnectedAt ? Date.now() - player.disconnectedAt : 0;

    player.isConnected = true;
    player.ws = ws;
    player.disconnectedAt = null;

    // 同步更新房间引用
    if (gameSession.roomCode) {
      const room = roomManager.getRoom(gameSession.roomCode);
      if (room) {
        const roomPlayer = room.players.get(playerId);
        if (roomPlayer) {
          roomPlayer.isConnected = true;
          roomPlayer.ws = ws;
          delete roomPlayer.disconnectedAt;
        }
        room.checkEmptyRoom();
      }
    }

    // === 人类玩家重连后自动恢复自动暂停的游戏 ===
    // 只有因所有人类玩家离线导致的自动暂停才恢复，手动暂停不自动恢复
    if (gameSession.gameData && gameSession.gameData.isPaused && gameSession.gameData.pauseReason === 'all_humans_disconnected') {
      console.log(`[重连] 游戏处于自动暂停状态，检测到人类玩家${playerId}重连，自动恢复游戏`);
      gameSession.gameData.isPaused = false;
      delete gameSession.gameData.pauseReason;
      accumulatePausedTime(gameSession.gameData);
      if (gameSession.gameData.gamePhase === 'paused') {
        gameSession.gameData.gamePhase = gameSession.gameData.gamePhaseBeforePause || 'rolling';
      }
      const resumedSession = getAuthoritySession(gameSession.gameSessionId);
      // 广播游戏恢复消息给所有玩家（包括重连者将会在 gameSessionConnected 中同步）
      gameSession.broadcast({
        type: 'gameResumed',
        playerId,
        reason: 'human_player_reconnected',
        timestamp: Date.now()
      });
      // 恢复后补一份权威快照，让各端立刻对齐阶段（markResumed 同时重置看门狗计时）
      if (resumedSession) {
        commitSnapshot(gameSession, resumedSession.markResumed());
      }
    }

  }

  // 更新其他玩家的连接状态（仅连接状态，不要修改音频加载状态）
  // 音频加载状态必须只由客户端显式发送 audioLoaded 来驱动，否则会导致 allAudioLoaded 被提前广播。
  gameSession.players.forEach((p, id) => {
    if (id !== playerId) {
      const otherWs = roomManager.getPlayerConnection(id);
      if (otherWs?.readyState === WebSocket.OPEN) {
        // 同时更新其他玩家的isConnected状态
        if (!p.isAI && !p.isConnected) {
          p.isConnected = true;
          console.log(`[重连] 更新玩家${id}的isConnected状态为true`);
        }
      }
    }
  });

  // 发送重连确认
  console.log(`[重连] 发送gameSessionConnected给玩家${playerId}，currentPlayer=${gameSession.gameData.currentPlayer}`);
  ws.send(JSON.stringify({
    type: 'gameSessionConnected',
    playerId,
    gameSessionId,
    gameSession: gameSession.toJSON(),
    audioLoadedPlayers: Array.from(gameSession.audioLoadedPlayers) // 同步已加载玩家列表
  }));
  sendSnapshotTo(ws, gameSessionId);
  if (message.needsHistory) {
    sendGameInfoHistoryTo(ws, gameSession);
  }

  // 如果所有人（包括重连者之前记录的状态）都已经加载完音频，
  // 补发一个 allAudioLoaded 信号给重连玩家，确保其 UI 能正常关闭
  const realPlayerCount = Array.from(gameSession.players.values()).filter(p => !p.isAI).length;
  console.log(`[重连] 检查音频加载状态: ${gameSession.audioLoadedPlayers.size}/${realPlayerCount}`);
  if (gameSession.audioLoadedPlayers.size === realPlayerCount) {
    console.log(`[重连] 所有玩家已加载，补发 allAudioLoaded 给玩家 ${playerId}`);
    ws.send(JSON.stringify({
      type: 'allAudioLoaded',
      gameSessionId: gameSession.gameSessionId,
      isResync: true
    }));
  }

  // 广播重连（只发送玩家列表，不发送全量 gameData 减轻其他客户端解析负担）
  console.log(`[重连] 玩家${playerId}重连成功，广播playerReconnected给其他玩家`);

  const playersArray = Array.from(gameSession.players.values()).map(p => ({
    id: p.id, color: p.color, nickname: p.nickname, emoji: p.emoji,
    isHost: p.isHost || false, isConnected: p.isConnected, isAI: p.isAI
  }));
  for (const [otherPlayerId] of gameSession.players) {
    if (otherPlayerId === playerId) continue;
    const otherWs = roomManager.getPlayerConnection(otherPlayerId);
    if (otherWs && otherWs.readyState === WebSocket.OPEN) {
      otherWs.send(JSON.stringify({
        type: 'playerReconnected',
        playerId,
        players: playersArray
      }));
    }
  }

  // 如果游戏处于激活状态（非暂停），确保 gameData.thinkingStartTime 已设置
  //（progressBarStart 已在第3145行保存到 gameData，但如果还没有 progressBarStart，
  // 设置一个当前时间作为 fallback）
  if (wasDisconnected && gameSession.gameData && !gameSession.gameData.isPaused) {
    if (!gameSession.gameData.thinkingStartTime) {
      gameSession.gameData.thinkingStartTime = Date.now();
      console.log(`[重连] 无 thinkingStartTime，设置当前时间: ${gameSession.gameData.thinkingStartTime}`);
    } else {
      console.log(`[重连] 现有 thinkingStartTime=${gameSession.gameData.thinkingStartTime}，传给重连者`);
    }
  }

  // 发送重连消息
  if (wasDisconnected && player) {
    console.log(`[重连] 玩家${playerId}断开时长${disconnectDuration}ms，广播“回来了”系统消息`);
    broadcastSystemChat(gameSession, `${player.nickname}回来了`, playerId);
  }

  // 骰子/阶段等棋面状态统一由上面的 sendSnapshotTo 权威快照恢复，无需额外补发

  // 检查当前房主是否在线，如果不在线且当前重连的是真实玩家，则接管房主
  // 仅在游戏稳定期（开始15秒后）才允许重连者主动接管，防止开局加载时的竞争
  const timeSinceStart = Date.now() - (gameSession.createdAt || 0);
  if (timeSinceStart >= 15000 && player && !player.isAI) {
    const currentHost = Array.from(gameSession.players.values()).find(p => p.isHost);
    
    // 如果重连的人自己就是房主，并且他成功连上了，那他理所当然保留房主，无需接管逻辑
    if (currentHost && currentHost.id === playerId) {
      console.log(`[重连] 房主 ${playerId} 成功归来，继续担任房主`);
    } else {
      const hostWs = currentHost ? roomManager.getPlayerConnection(currentHost.id) : null;
      const isHostOnline = currentHost && currentHost.isConnected && hostWs && hostWs.readyState === 1;

      if (!isHostOnline) {
        console.log(`[重连] 房主 ${currentHost ? currentHost.id : '无'} 不在线，玩家 ${playerId} 接管房主`);
        
        for (const [pId, p] of gameSession.players) {
          if (p) p.isHost = (pId === playerId);
        }
        gameSession.hostId = playerId;

        if (gameSession.roomCode) {
          const room = roomManager.getRoom(gameSession.roomCode);
          if (room) {
            const roomNewHost = room.players.get(playerId);
            if (roomNewHost) {
              room.host = roomNewHost;
              for (const p of room.players.values()) {
                if (p) p.isHost = (p.id === playerId);
              }
            }
          }
        }

        recordHostChange(gameSession, player);
        gameSession.broadcast({
          type: 'hostChanged',
          oldHostId: currentHost ? currentHost.id : null,
          newHostId: playerId,
          newHostNickname: player.nickname,
          gameSession: gameSession.toJSON(),
          timestamp: Date.now()
        });
      }
    }
  }
}

// 配置棋子数量（需要房主权限）
const handleConfigurePieceCount = withRoomValidation((ws, playerId, message, room) => {
  const { pieceCount } = message;
  if (![1, 2, 3, 4].includes(pieceCount)) throw new Error('无效的棋子数量');

  room.settings.pieceCount = pieceCount;
  // 广播配置结果
  room.broadcast({ type: 'pieceCountConfigured', pieceCount, room: room.toJSON() });
}, true);


// 游戏信息同步（使用通用广播目标，避免回显给发送者）
// 战报的正史由服务端事件流留档（authority.eventLog）承担，这里只做实时转发，
// 不再复制一份消息，避免刷新回放与实时消息叠加出重复。
function handleGameInfo(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);

  // 战报由发送方本地先渲染一次，这里排除发送者避免重复
  target.broadcast({
    type: 'gameInfo',
    playerId,
    messageData: message.messageData,
    timestamp: message.timestamp
  }, playerId);
}

// 游戏暂停（使用通用广播目标）
function handleGamePause(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);

  if (target instanceof GameSession && target.gameData) {
    target.gameData.isPaused = true;
    target.gameData.pauseReason = 'manual';
    target.gameData.pausedAt = Date.now();
    target.gameData.gamePhaseBeforePause = target.gameData.gamePhase;
    target.gameData.gamePhase = 'paused';
  }

  target.broadcast({
    type: 'gamePaused',
    playerId,
    timestamp: message.timestamp
  });
}

// 游戏继续（使用通用广播目标）
function handleGameResume(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);
  const session = target instanceof GameSession ? getAuthoritySession(target.gameSessionId) : null;

  if (target instanceof GameSession && target.gameData) {
    target.gameData.isPaused = false;
    delete target.gameData.pauseReason;
    accumulatePausedTime(target.gameData);
    if (target.gameData.gamePhase === 'paused') {
      target.gameData.gamePhase = target.gameData.gamePhaseBeforePause || 'rolling';
    }
  }

  target.broadcast({
    type: 'gameResumed',
    playerId,
    timestamp: message.timestamp
  });

  // 暂停期间各端的本地阶段可能被冻在半截（刷新回来的客户端会停在 waiting），
  // 补一份权威快照让所有人立刻对齐，而不是等 25 秒心跳
  if (session) {
    commitSnapshot(target, session.markResumed());
    botDriver.kick(target);
  }
}

// AI托管切换（房主代理发送，message.playerId 才是被托管的玩家）
function handleAITakeoverChange(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);
  const targetPlayerId = message.playerId || playerId;

  // isAITakeover 是权威层判定「谁能代理这个玩家发起 intent」的依据
  if (target.players && target.players.has(targetPlayerId)) {
    target.players.get(targetPlayerId).isAITakeover = message.isActive;
  }

  target.broadcast({
    type: 'aiTakeoverChange',
    playerId: targetPlayerId,
    isActive: message.isActive,
    auto: message.auto,
    reason: message.reason,
    timestamp: message.timestamp
  });

  // 托管开关一变就重排一拍：开着托管又正轮到他（比如刚掷完骰子在选子），
  // AI 要立刻接手，别干等思考窗口——原来就是这个空档，看着像卡住了
  if (target instanceof GameSession) botDriver.kick(target);
}

// 音效开关（玩家自己的偏好，落在会话与房间上以便刷新/重连恢复）
function handleAudioEnabledChange(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);
  const enabled = !!message.enabled;

  const gameSession = roomManager.getPlayerGameSession(playerId);
  if (gameSession && gameSession.players.has(playerId)) {
    gameSession.players.get(playerId).audioEnabled = enabled;
  }
  const room = roomManager.getPlayerRoom(playerId);
  if (room && room.players.has(playerId)) {
    room.players.get(playerId).audioEnabled = enabled;
  }

  target.broadcast({
    type: 'audioEnabledChange',
    playerId,
    enabled,
    timestamp: message.timestamp || Date.now()
  });
}

// 先广播，再清理会话映射。
// 否则 removeGameSession 会清空 playerSessions，导致 GameSession.broadcast 由于映射校验而不发送给任何人。
function broadcastEndPayload(target, payload) {
  try {
    if (target && target.players && typeof target.players.forEach === 'function') {
      const connectionSnapshot = [];
      target.players.forEach(p => {
        const conn = roomManager.getPlayerConnection(p.id);
        connectionSnapshot.push({ playerId: p.id, isAI: !!p.isAI, wsOpen: !!(conn && conn.readyState === WebSocket.OPEN) });
      });
      console.log(`[${payload.type}] broadcast snapshot:`, connectionSnapshot);
    }
  } catch (e) {
    // ignore
  }

  const gameData = target && target.gameData ? target.gameData : {};
  target.broadcast({
    ...payload,
    gameStartTime: gameData.gameStartTime,
    progressHistory: gameData.progressHistory,
    currentRound: gameData.currentRound
  });
}

// 结算后统一收尾：终止会话、清理掉线玩家、必要时销毁空房间
function finalizeGameRoom(playerId, logLabel) {
  const room = roomManager.getPlayerRoom(playerId);
  if (!room || room.gameState !== 'playing') return;

  console.log(`房间 ${room.code} ${logLabel}，状态改为 finished`);
  room.gameState = 'finished';

  if (room.gameSessionId) {
    roomManager.removeGameSession(room.gameSessionId);
    room.gameSessionId = null;
  }

  try {
    const offlinePlayerIds = [];
    for (const [pid, p] of room.players) {
      if (p && p.isConnected === false) offlinePlayerIds.push(pid);
    }

    if (offlinePlayerIds.length > 0) {
      console.log(`房间 ${room.code} ${logLabel}后清理已掉线玩家:`, offlinePlayerIds);
      for (const offlineId of offlinePlayerIds) {
        room.removePlayer(offlineId);
        roomManager.playerRooms.delete(offlineId);
      }
      if (room.players.size > 0) {
        room.broadcast({ type: 'roomUpdated', room: room.toJSON() });
      }
    }
  } catch (e) {
    console.error(`${logLabel}后清理离线玩家时出错:`, e);
  }

  if (room.players.size === 0) {
    console.log(`房间 ${room.code} ${logLabel}后无玩家，加入清理队列`);
    roomManager.scheduleRoomDestroy(room.code);
  }

  dailyStats.recordGameFinished();
}

// 游戏结束
function handleGameEnd(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);
  broadcastEndPayload(target, {
    type: 'gameEnd',
    playerId,
    winnerPlayer: message.winnerPlayer,
    titleStats: message.titleStats || undefined,
    timestamp: message.timestamp
  });
  finalizeGameRoom(playerId, '游戏结束');
}

// 强制结算
function handleForceSettlement(ws, playerId, message) {
  const target = requireBroadcastTarget(playerId);
  broadcastEndPayload(target, {
    type: 'forceSettlement',
    playerId,
    rankings: message.rankings,
    titleStats: message.titleStats || undefined,
    timestamp: message.timestamp
  });
  finalizeGameRoom(playerId, '被房主强制结算');
}

/**
 * 房主变更只留档、不广播：各端收到 hostChanged 后会自己渲染一条本地提示，
 * 这里再播一遍就重复了；但那份提示是客户端本地生成的，刷新即丢，所以补一条历史。
 */
function recordHostChange(gameSession, newHost) {
  if (!gameSession || !newHost) return;
  gameSession.recordChat({
    type: 'chatMessage',
    message: `${newHost.nickname} 成为了新房主`,
    playerNumber: null,
    playerName: null,
    isSystemMessage: true,
    timestamp: Date.now()
  });
}

/**
 * 系统提示（退出/回来了/首发权转移…）：广播的同时在会话或房间的聊天历史里留一份。
 * 原来只广播不留档，刷新后这些行就没了（右侧面板里只剩玩家聊天）。
 */
function broadcastSystemChat(target, messageText, excludePlayerId = null) {
  const payload = {
    type: 'chatMessage',
    message: messageText,
    playerNumber: null,
    playerName: null,
    isSystemMessage: true,
    timestamp: Date.now()
  };
  if (target instanceof GameSession) target.recordChat(payload);
  else if (target instanceof Room) target.appendRoomChatMessage(payload);
  target.broadcast(payload, excludePlayerId);
}

// 观战者没填昵称时拿 playerId 兜底，前缀换成中文，面板里不至于露出一串英文 ID
function spectatorDisplayName(playerId) {
  return String(playerId).replace(/^player_/, '玩家_');
}

// 处理聊天消息
function handleChatMessage(ws, playerId, message) {
  const rawMessage = message?.message ?? '';
  const sanitizedMessage = sanitizeText(rawMessage);
  if (!String(sanitizedMessage).trim()) {
    return;
  }

  // 观战者不在 playerRooms / playerSessions 里，只能借观战映射定位房间；
  // 广播与留档沿用房间/会话既有通道，观战席位已在两者的 broadcast 投递范围内
  const spectatingRoomCode = roomManager.playerSpectatingRooms.get(playerId);
  if (spectatingRoomCode) {
    const room = roomManager.getRoom(spectatingRoomCode);
    if (!room) throw new Error('观战房间不存在');
    const gameSession = room.gameSessionId ? roomManager.getGameSession(room.gameSessionId) : null;
    const chatPayload = {
      type: 'chatMessage',
      playerId,
      playerNumber: null,
      playerName: room.spectatorNames.get(playerId) || spectatorDisplayName(playerId),
      message: sanitizedMessage,
      isSpectatorMessage: true,
      timestamp: message?.timestamp || Date.now()
    };
    if (gameSession) gameSession.recordChat(chatPayload);
    else room.appendRoomChatMessage({ ...chatPayload, isSystemMessage: false });
    (gameSession || room).broadcast(chatPayload);
    return;
  }

  const target = requireBroadcastTarget(playerId);

  // 获取玩家信息
  const player = target.players.get(playerId);
  if (!player) throw new Error('找不到玩家信息');

  const chatPayload = {
    type: 'chatMessage',
    playerId,
    playerNumber: player.color, // 统一用color（1-4）
    playerName: sanitizeText(player.nickname),
    message: sanitizedMessage,
    timestamp: message?.timestamp || Date.now()
  };

  // 在房间阶段写入房间聊天历史（保留最近50条）
  if (target instanceof Room) {
    target.appendRoomChatMessage({
      playerId: chatPayload.playerId,
      playerNumber: chatPayload.playerNumber,
      playerName: chatPayload.playerName,
      message: chatPayload.message,
      timestamp: chatPayload.timestamp,
      isSystemMessage: false
    });
  } else if (target instanceof GameSession) {
    // 对局内聊天同样留一份，刷新/重连后可回放
    target.recordChat(chatPayload);
  }

  // 广播聊天消息
  target.broadcast(chatPayload);
}

// 音频加载完成（使用游戏会话中间件）
const handleAudioLoaded = withGameSessionValidation((ws, playerId, message, gameSession) => {
  // 记录音频加载状态
  gameSession.audioLoadedPlayers.add(playerId);
  // 计算真实玩家数量（排除AI）
  const realPlayerCount = Array.from(gameSession.players.values()).filter(p => !p.isAI).length;
  console.log(`[音频加载] 玩家 ${playerId} 加载完成. 会话: ${gameSession.gameSessionId}, 当前已加载: ${gameSession.audioLoadedPlayers.size}/${realPlayerCount}. 列表:`, Array.from(gameSession.audioLoadedPlayers));

  // 广播加载状态
  gameSession.broadcast({
    type: 'audioLoaded',
    playerId,
    loadedCount: gameSession.audioLoadedPlayers.size,
    totalCount: realPlayerCount,
    allLoaded: gameSession.audioLoadedPlayers.size === realPlayerCount
  });

  // 所有真实玩家加载完成
  if (gameSession.audioLoadedPlayers.size === realPlayerCount) {
    // 如果游戏已经开始，说明这是重连补发的 audioLoaded，不广播 allAudioLoaded
    // 避免干扰其他玩家正在进行的游戏流程（如AI操作、骰子动画等）
    if (gameSession.gameData?.gameOfficiallyStarted) {
      console.log(`[音频加载] 游戏已开始，跳过 allAudioLoaded 广播（防止干扰进行中的游戏流程）`);
    } else {
      console.log(`[音频加载] 游戏会话 ${gameSession.gameSessionId} 所有玩家已加载，发送 allAudioLoaded`);
      gameSession.broadcast({ type: 'allAudioLoaded', gameSessionId: gameSession.gameSessionId });
    }
  }
});

// 生成玩家ID
function generatePlayerId() {
  return `player_${Math.random().toString(36).substr(2, 4)}`;
}

/**
 * 查询所有房间信息
 * GET /api/rooms
 */
app.get('/api/rooms', (req, res) => {
  try {
    const roomsInfo = Array.from(roomManager.rooms.values()).map(room => room.toJSON());

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalRooms: roomsInfo.length,
      rooms: roomsInfo
    });
  } catch (error) {
    console.error('获取房间信息失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 查询所有游戏会话信息
 * GET /api/sessions
 */
app.get('/api/sessions', (req, res) => {
  try {
    const sessionsInfo = [];

    for (const [sessionId, session] of roomManager.gameSessions.entries()) {
      const players = Array.from(session.players.values()).map(p => ({
        id: p.id,
        nickname: p.nickname,
        emoji: p.emoji,
        playerNumber: p.color,
        isConnected: p.isConnected,
        isAI: p.isAI,
        isHost: p.id === session.hostId // 添加房主标志
      }));

      sessionsInfo.push({
        sessionId,
        roomCode: session.roomCode,
        hostId: session.hostId,
        playerCount: session.players.size,
        players,
        pieceCount: session.pieceCount,
        skillMode: session.skillMode,
        gameState: session.gameData ? {
          currentPlayer: session.gameData.currentPlayer,
          gamePhase: session.gameData.gamePhase,
          diceValue: session.gameData.diceValue,
          winner: session.gameData.winner
        } : null,
        createdAt: session.createdAt
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalSessions: sessionsInfo.length,
      sessions: sessionsInfo
    });
  } catch (error) {
    console.error('获取游戏会话信息失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取在线用户列表及其详细状态
 * GET /api/online-users
 */
app.get('/api/online-users', (req, res) => {
  try {
    const users = [];

    // 遍历所有活跃的 WebSocket 连接
    for (const [playerId, ws] of roomManager.playerConnections.entries()) {
      if (ws.readyState !== WebSocket.OPEN) {
        roomManager.playerConnections.delete(playerId);
        continue;
      }

      let status = 'idle'; // 默认：首页/空闲
      let roomCode = null;
      let gameSessionId = null;
      let nickname = `玩家_${playerId.slice(-4)}`;

      // 1. 检查是否在游戏中
      const gameSession = roomManager.getPlayerGameSession(playerId);
      if (gameSession) {
        status = 'playing';
        gameSessionId = gameSession.gameSessionId;
        roomCode = gameSession.roomCode;
        const p = gameSession.players.get(playerId);
        if (p) nickname = p.nickname;
      }
      // 2. 检查是否在观战中
      else if (roomManager.playerSpectatingRooms.has(playerId)) {
        status = 'spectating';
        roomCode = roomManager.playerSpectatingRooms.get(playerId);
        // 观战者通常没有存储在房间的 players Map 里，使用默认昵称或尝试从之前的连接中寻找
      }
      // 3. 检查是否在房间中
      else {
        const room = roomManager.getPlayerRoom(playerId);
        if (room) {
          status = 'in_room';
          roomCode = room.code;
          const p = room.players.get(playerId);
          if (p) nickname = p.nickname;
        }
      }

      users.push({
        playerId,
        nickname,
        status,
        roomCode,
        gameSessionId
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      totalOnline: users.length,
      users
    });
  } catch (error) {
    console.error('获取在线用户列表失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 查询每日统计
 * GET /api/daily-stats
 */
app.get('/api/daily-stats', (req, res) => {
  res.json(dailyStats.toJSON());
});

/**
 * 查询最近若干天的统计（默认 30 天，最多 90 天，最新在前）
 * GET /api/daily-history?days=30
 */
app.get('/api/daily-history', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
  res.json({ days: dailyStats.history(days) });
});

/**
 * 查询服务器统计信息
 * GET /api/stats
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      rooms: {
        total: roomManager.rooms.size,
        waiting: 0,
        playing: 0
      },
      sessions: {
        total: roomManager.gameSessions.size
      },
      players: {
        totalConnections: 0,
        inRooms: 0, // 仅统计在线
        inSessions: 0 // 仅统计在线
      },
      timers: {
        roomDestroyTimers: roomManager.roomDestroyTimers.size,
        disconnectTimers: roomManager.disconnectTimers.size
      }
    };

    // 统计在线玩家分布
    for (const [playerId, ws] of roomManager.playerConnections.entries()) {
      if (ws.readyState !== WebSocket.OPEN) {
        roomManager.playerConnections.delete(playerId);
        continue;
      }
      
      stats.players.totalConnections++;
      
      if (roomManager.playerSessions.has(playerId)) {
        stats.players.inSessions++;
      } else if (roomManager.playerRooms.has(playerId)) {
        stats.players.inRooms++;
      }
    }

    // 更新每日峰值在线
    dailyStats.recordConnectionCount(stats.players.totalConnections);

    // 统计房间状态
    let cleanupRoomsCount = 0;
    for (const room of roomManager.rooms.values()) {
      if (room.gameState === 'waiting') {
        stats.rooms.waiting++;
      } else if (room.gameState === 'playing') {
        stats.rooms.playing++;
      } else if (room.gameState === 'finished') {
        stats.rooms.finished = (stats.rooms.finished || 0) + 1;
      }
      
      // 如果没有人类玩家且状态是游戏中或等待中，逻辑上属于待清理状态
      // 或者是没有任何玩家（连AI都没有）的空房间
      const noHumanPlayers = !room.hasHumanPlayers();
      const isEmpty = room.players.size === 0;
      
      const isCleanupState = 
        (noHumanPlayers && (room.gameState === 'playing' || room.gameState === 'waiting')) || 
        (isEmpty && room.gameState === 'finished');
        
      if (isCleanupState) {
        cleanupRoomsCount++;
      }
    }
    stats.rooms.cleanup = cleanupRoomsCount;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      stats
    });
  } catch (error) {
    console.error('获取统计信息失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 手动清理孤立资源
 * POST /api/cleanup
 */
app.post('/api/cleanup', (req, res) => {
  try {
    const result = cleanupOrphanedResources();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      cleaned: result,
      message: `清理完成: ${result.sessions}个孤立会话, ${result.rooms}个已结束房间, ${result.connections}个死连接`
    });
  } catch (error) {
    console.error('清理失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 清理孤立资源的核心函数
 * @returns {Object} 清理结果 { sessions: 清理的会话数, rooms: 清理的房间数 }
 */
function cleanupOrphanedResources() {
  console.log('\n===== 开始清理孤立资源 =====');
  let cleanedSessions = 0;
  let cleanedRooms = 0;
  let cleanedConnections = 0;
  for (const [playerId, ws] of roomManager.playerConnections.entries()) {
    if (ws.readyState !== WebSocket.OPEN) {
      roomManager.playerConnections.delete(playerId);
      cleanedConnections++;
    }
  }

  // 1. 清理孤立的游戏会话（对应房间不存在或已finished）
  const orphanedSessions = [];
  for (const [sessionId, session] of roomManager.gameSessions.entries()) {
    const room = session.roomCode ? roomManager.getRoom(session.roomCode) : null;

    // 会话孤立的条件：
    // - 没有关联房间
    // - 关联的房间不存在
    // - 关联的房间状态为finished
    if (!session.roomCode || !room || room.gameState === 'finished') {
      orphanedSessions.push(sessionId);
      console.log(`  发现孤立会话: ${sessionId} (房间: ${session.roomCode || '无'}, 房间状态: ${room ? room.gameState : '不存在'})`);
    }
  }

  // 删除孤立会话
  for (const sessionId of orphanedSessions) {
    roomManager.removeGameSession(sessionId);
    cleanedSessions++;
  }

  // 2. 清理非游戏进行中且无人类玩家的房间，以及空置超时的游戏房间
  const emptyRoomsToClean = [];
  const NOW = Date.now();
  for (const [roomCode, room] of roomManager.rooms.entries()) {
    if (!room.hasHumanPlayers()) {
      if (room.gameState !== 'playing') {
        emptyRoomsToClean.push(roomCode);
        console.log(`  发现无人类玩家的僵尸房间 (${room.gameState}): ${roomCode}`);
      } else {
        // 游戏中房间先靠延迟销毁定时器，这里兜底定时器丢失：以「全员离线自动暂停的时刻」
        // 为起点，超过销毁窗口还没走掉就强制清理（定时器跑过会把自己从表里摘掉，不能只看它）
        const session = roomManager.getGameSession(room.gameSessionId);
        const pausedAt = session?.gameData?.pausedAt || 0;
        const destroyEntry = roomManager.roomDestroyTimers.get(roomCode);
        const deadline = ROOM_LIFECYCLE.EMPTY_ROOM_DESTROY_MS + 60 * 1000;
        const overdueByTimer = destroyEntry?.startedAt && NOW - destroyEntry.startedAt > deadline;
        const overdueByPause = pausedAt && NOW - pausedAt > deadline;
        if (overdueByTimer || overdueByPause) {
          emptyRoomsToClean.push(roomCode);
          console.log(`  发现空置超时的僵尸游戏房间 (${room.gameState}): ${roomCode}`);
        }
      }
    } else if (room.gameState === 'finished') {
      // 如果房间是finished且没有人类玩家（上面已处理），或者是全空的
      if (room.players.size === 0) {
        emptyRoomsToClean.push(roomCode);
        console.log(`  发现已结束空房间: ${roomCode}`);
      }
    }
  }

  // 删除这些房间
  for (const roomCode of emptyRoomsToClean) {
    const room = roomManager.rooms.get(roomCode);
    if (!room) continue;

    roomManager.immediateDestroyRoom(roomCode);
    cleanedRooms++;
  }

  console.log(`===== 清理完成: ${cleanedSessions}个会话, ${cleanedRooms}个房间, ${cleanedConnections}个死连接 =====\n`);

  return {
    sessions: cleanedSessions,
    rooms: cleanedRooms,
    connections: cleanedConnections
  };
}

// -------------------------- 静态文件服务 --------------------------
app.use(express.static(path.resolve(__dirname, '../frontend')));
app.use('/shared', express.static(path.resolve(__dirname, '../shared')));

// -------------------------- 定时清理任务 --------------------------
/**
 * 每10分钟自动清理孤立资源
 */
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10分钟

function startAutoCleanup() {
  console.log('启动自动清理任务（每10分钟执行一次）');

  // 立即执行一次清理
  cleanupOrphanedResources();

  // 设置定时清理
  setInterval(() => {
    console.log('\n[定时任务] 执行自动清理');
    cleanupOrphanedResources();
  }, CLEANUP_INTERVAL);
}

// -------------------------- 启动服务器 --------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`WebSocket服务器运行在 ws://localhost:${PORT}`);
  console.log(`\n管理面板: http://localhost:${PORT}/admin.html`);
  console.log(`\n查询接口:`);
  console.log(`  - 房间列表: http://localhost:${PORT}/api/rooms`);
  console.log(`  - 游戏会话: http://localhost:${PORT}/api/sessions`);
  console.log(`  - 服务器统计: http://localhost:${PORT}/api/stats`);
  console.log(`  - 手动清理: http://localhost:${PORT}/api/cleanup (POST)`);

  // 启动自动清理任务
  startAutoCleanup();

  // 启动回合看门狗，兜底被浏览器节流而停摆的对局
  startTurnWatchdog();
});
