/**
 * 房间 / 会话 / 玩家 领域模型
 *
 * 这里只放「数据结构 + 生命周期」：房间的创建销毁、会话与玩家的关联、连接的登记。
 * 网络协议与消息路由留在 server.cjs，本模块不感知 WebSocket 消息格式。
 *
 * 与外部世界的耦合通过依赖注入完成：
 *   - WebSocket 的 OPEN 常量（判断连接可用）
 *   - getDefaultNickname（玩家默认昵称）
 *   - dropAuthoritySession（删除权威棋面会话）
 *   - stats（每日统计，可为 null）
 */

const WebSocket = require('ws');

// -------------------------- 房间生命周期参数 --------------------------
const ROOM_CHAT_MAX_MESSAGES = 50;
// 对局内聊天的回放缓冲上限，玩家刷新/重连时据此补回面板内容
const GAME_CHAT_HISTORY_MAX = 50;

const ROOM_LIFECYCLE = {
  // 房间空置（无在线人类玩家）后保留多久再销毁；可用环境变量覆盖，便于测试
  EMPTY_ROOM_DESTROY_MS: Number(process.env.EMPTY_ROOM_DESTROY_MS) || 5 * 60 * 1000,
  // 断线后按所处阶段决定移除宽限
  DISCONNECT_GRACE_MS: {
    config: 10 * 1000,      // 大厅配置阶段
    waiting: 30 * 1000,     // 房间等待阶段
    playing: 5 * 60 * 1000  // 游戏进行中
  }
};

/** 空置销毁窗口的分钟数，用于提示文案 */
const EMPTY_ROOM_DESTROY_MINUTES = Math.round(ROOM_LIFECYCLE.EMPTY_ROOM_DESTROY_MS / 60000);

let deps = {
  getDefaultNickname: (id) => `玩家${String(id).slice(-4)}`,
  dropAuthoritySession: () => {},
  stats: null
};

function configureRoomManager(injected) {
  deps = { ...deps, ...injected };
}

class Player {
  constructor(id, ws, nickname = '', emoji = 'smile') {
    this.id = id;
    this.ws = ws;
    const normalizedNickname = String(nickname == null ? '' : nickname).trim();
    this.nickname = normalizedNickname || deps.getDefaultNickname(id);
    this.emoji = emoji;
    this.color = null;
    this.isHost = false;
    this.isConnected = true;
    this.disconnectedAt = null;
    // 音效开关偏好，null 表示客户端尚未上报过
    this.audioEnabled = null;
  }
}

class GameSession {
  constructor(gameSessionId, players, pieceCount = 4, roomCode = null, hostId = null, skillMode = false, happyMode = false) {
    this.gameSessionId = gameSessionId;
    // AI玩家不需要连接状态，只有真实玩家才设置为isConnected: true
    this.players = new Map(players.map(p => [p.id, { ...p, isConnected: p.isAI ? false : true, ws: null }]));
    this.gameState = 'playing';
    this.createdAt = Date.now();
    this.pieceCount = pieceCount;
    this.roomCode = roomCode;
    this.hostId = hostId;
    this.skillMode = skillMode;
    this.happyMode = happyMode;
    this.audioLoadedPlayers = new Set();
    this.aiTakeoverPlayers = new Set();
    this.spectators = new Set();

    // 对局内聊天回放缓冲，供刷新或重连的玩家补齐右侧面板；
    // 战报不在此留存，其正史由服务端事件流（authority.eventLog）投影重建
    this.chatHistory = [];

    this.gameData = {
      gameSessionId,
      gameStartTime: Date.now(),
      currentPlayer: null,
      gamePhase: 'rolling',
      diceValue: 0,
      winner: null,
      playerChess: {},
      defeatCounts: {},
      pieceCount,
      happyMode,
      canReroll: false,
      consecutiveSixes: 0,
      justRolledSix: false,
      diceValueConsumed: false,
      progressHistory: [],
      currentRound: 0,
      thinkingStartTime: null,
      pausedTotalMs: 0,
      pausedAt: null,
      gameOfficiallyStarted: false
    };

    players.forEach(player => {
      this.gameData.playerChess[player.color] = Array.from({ length: pieceCount }, () => ({
        position: -1,
        finished: false
      }));
      this.gameData.defeatCounts[player.color] = Object.fromEntries(
        players.filter(p => p.color !== player.color).map(p => [p.color, 0])
      );
    });
  }

  broadcast(message, excludePlayerId = null) {
    let sentCount = 0;
    this.players.forEach(player => {
      if (player && !player.isAI) {
        if (player.id === excludePlayerId) return;
        const mappedSessionId = manager.playerSessions.get(player.id);
        if (mappedSessionId !== this.gameSessionId) {
          return;
        }
      }
      const ws = manager.getPlayerConnection(player.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        sentCount++;
      }
    });

    if (this.spectators) {
      this.spectators.forEach(spectatorId => {
        const ws = manager.getPlayerConnection(spectatorId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
          sentCount++;
        }
      });
    }

    if (message.type === 'playerTurnChange') {
      console.log(`[broadcast] playerTurnChange消息已发送给${sentCount}个玩家`);
    }
    if (message.type === 'forceSettlement' || message.type === 'gameEnd') {
      console.log(`[broadcast] ${message.type}消息已发送给${sentCount}个玩家`);
    }
  }

  recordChat(chatItem) {
    if (!chatItem || typeof chatItem !== 'object') return;
    this.chatHistory.push(chatItem);
    if (this.chatHistory.length > GAME_CHAT_HISTORY_MAX) {
      this.chatHistory = this.chatHistory.slice(-GAME_CHAT_HISTORY_MAX);
    }
  }

  toJSON() {
    return {
      gameSessionId: this.gameSessionId,
      players: Array.from(this.players.values()).map(p => ({
        ...p,
        isHost: p.isHost || false
      })),
      gameState: this.gameState,
      createdAt: this.createdAt,
      gameData: this.gameData
    };
  }
}

class Room {
  constructor(code, hostPlayer, name = '') {
    this.code = code;
    this.name = name || `${hostPlayer.nickname}的房间`;
    this.isPrivate = false;
    this.host = hostPlayer;
    hostPlayer.isHost = true;
    this.players = new Map();
    this.playerReadyStatus = new Map();
    this.gameState = 'waiting';
    this.gameSessionId = null;
    this.postGameHostId = null;
    this.settings = { pieceCount: 4, aiPlayers: [], skillMode: false, happyMode: false };
    this.spectators = new Set();
    // 观战者没有 Player 对象，聊天需要显示昵称，进房时单独留档
    this.spectatorNames = new Map();
    this.roomChatHistory = [];
    this.createdAt = Date.now();
    this.addPlayer(hostPlayer);
    this.playerReadyStatus.set(hostPlayer.id, true);
  }

  addPlayer(player) {
    const usedColors = [
      ...Array.from(this.players.values()).map(p => p.color),
      ...this.settings.aiPlayers.map(ai => ai.color)
    ];
    const availableColors = [1, 2, 3, 4].filter(c => !usedColors.includes(c));
    if (availableColors.length === 0) throw new Error('房间已满');

    player.color = player.isHost && availableColors.includes(1) ? 1 : availableColors[0];
    this.players.set(player.id, player);

    if (player.isHost) {
      this.playerReadyStatus.set(player.id, true);
    } else {
      this.playerReadyStatus.set(player.id, false);
    }
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return { wasHost: false, newHost: this.host };

    const wasHost = this.host.id === playerId;
    if (wasHost) player.isHost = false;

    this.players.delete(playerId);
    this.playerReadyStatus.delete(playerId);

    let newHost = this.host;
    if (wasHost && this.players.size > 0) {
      newHost = Array.from(this.players.values())[0];
      newHost.isHost = true;
      this.host = newHost;
      this.playerReadyStatus.set(newHost.id, true);
      console.log(`房主权限从 ${playerId} 转移到 ${newHost.id} (${newHost.nickname})`);
      this.broadcast({
        type: 'hostTransferred',
        newHostId: newHost.id,
        newHostNickname: newHost.nickname,
        room: this.toJSON()
      });
      console.log(`新房主: ${newHost.id} (${newHost.nickname})`);
    }

    this.checkEmptyRoom();

    return { wasHost, newHost };
  }

  hasHumanPlayers() {
    for (const player of this.players.values()) {
      if (!player.isAI && player.isConnected) {
        const ws = manager.getPlayerConnection(player.id);
        if (ws && ws.readyState === WebSocket.OPEN) {
          return true;
        }
        // 有 isConnected 标记但没有真实连接 → 标记已断开
        player.isConnected = false;
        player.ws = null;
        player.disconnectedAt = player.disconnectedAt || Date.now();
      }
    }
    return false;
  }

  /**
   * 房间无在线人类玩家时的统一处理：游戏中则暂停并延时销毁，否则立即销毁。
   * 注意：销毁定时器统一由 manager 持有，Room 自身不再维护额外的空置计时器。
   */
  checkEmptyRoom() {
    if (this.hasHumanPlayers()) {
      manager.cancelRoomDestroy(this.code);
      return;
    }

    console.log(`房间 ${this.code} 已没有人类玩家在线`);

    if (this.gameState === 'playing') {
      console.log(`房间 ${this.code} 游戏已暂停，${EMPTY_ROOM_DESTROY_MINUTES}分钟后若无人类玩家重连将销毁`);

      const session = manager.getGameSession(this.gameSessionId);
      if (session && session.gameData) {
        session.gameData.isPaused = true;
        session.gameData.pauseReason = 'all_humans_disconnected';
        session.gameData.pausedAt = Date.now();
        session.gameData.gamePhaseBeforePause = session.gameData.gamePhase;
        session.gameData.gamePhase = 'paused';
      }

      this.broadcast({
        type: 'gameAutoPaused',
        reason: 'no_human_players',
        message: `所有人类玩家已离线，游戏已暂停。${EMPTY_ROOM_DESTROY_MINUTES}分钟内重连可继续游戏。`,
        timestamp: Date.now()
      });

      manager.scheduleRoomDestroy(this.code, {
        reason: 'no_humans_timeout',
        notice: {
          type: 'roomDestroying',
          reason: 'no_humans_timeout',
          message: `${EMPTY_ROOM_DESTROY_MINUTES}分钟内无人类玩家重连，房间即将销毁`,
          timestamp: Date.now()
        }
      });
    } else {
      manager.immediateDestroyRoom(this.code);
    }
  }

  updateSettings(settings) {
    console.log('[房间配置] 更新设置:', { 旧设置: this.settings, 新设置: settings, 房间号: this.code });
    this.settings = { ...this.settings, ...settings };
    console.log('[房间配置] 更新后的设置:', this.settings);
  }

  appendRoomChatMessage(chatItem) {
    if (!chatItem || typeof chatItem !== 'object') return;
    this.roomChatHistory.push(chatItem);
    if (this.roomChatHistory.length > ROOM_CHAT_MAX_MESSAGES) {
      this.roomChatHistory = this.roomChatHistory.slice(-ROOM_CHAT_MAX_MESSAGES);
    }
  }

  broadcast(message, excludePlayerId = null) {
    this.players.forEach(player => {
      if (player.id !== excludePlayerId && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
      }
    });
    if (this.spectators) {
      this.spectators.forEach(spectatorId => {
        const ws = manager.getPlayerConnection(spectatorId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
        }
      });
    }
  }

  toJSON() {
    const displayState = (!this.hasHumanPlayers() && (this.gameState === 'playing' || this.gameState === 'waiting')) ? 'cleanup' : this.gameState;

    let sessionData = null;
    if (this.gameSessionId) {
      const session = manager.getGameSession(this.gameSessionId);
      if (session) {
        sessionData = session.toJSON();
      }
    }

    return {
      code: this.code,
      name: this.name,
      isPrivate: !!this.isPrivate,
      host: this.host.id,
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        nickname: p.nickname,
        color: p.color,
        playerNumber: p.color,
        emoji: p.emoji,
        isHost: p.id === this.host.id,
        isAI: !!p.isAI,
        isReady: this.playerReadyStatus.get(p.id) || false,
        isConnected: !!p.isConnected,
        disconnectedAt: p.disconnectedAt
      })),
      gameState: this.gameState,
      displayState,
      gameSession: sessionData,
      playerReadyStatus: Object.fromEntries(this.playerReadyStatus),
      settings: this.settings,
      roomChatHistory: this.roomChatHistory
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.playerRooms = new Map();
    this.gameSessions = new Map();
    this.playerSessions = new Map();
    this.playerSpectatingRooms = new Map();
    this.playerConnections = new Map();

    // 房间销毁：roomCode -> { timer, reason, notice }
    this.roomDestroyTimers = new Map();
    // playerId -> Timer（断线后延迟移除）
    this.disconnectTimers = new Map();
    // playerId -> Timer（连接切换去抖）
    this.disconnectDebounceTimers = new Map();
    // playerId -> 时间戳（重连冷却），随重连推进清理，避免无界增长
    this.rejoinCooldowns = new Map();
  }

  generateRoomCode() {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code;
    do {
      code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  generateGameSessionId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let sessionId;
    do {
      const randomStr = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      sessionId = `game_${randomStr}`;
    } while (this.gameSessions.has(sessionId));
    return sessionId;
  }

  createRoom(hostPlayer, roomName = '') {
    const roomCode = this.generateRoomCode();
    const room = new Room(roomCode, hostPlayer, roomName);
    this.rooms.set(roomCode, room);
    this.playerRooms.set(hostPlayer.id, roomCode);
    this.setPlayerConnection(hostPlayer.id, hostPlayer.ws);
    return room;
  }

  joinRoom(roomCode, player) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('房间不存在');

    // 重连逻辑
    const existingPlayer = Array.from(room.players.values()).find(p => p.id === player.id);
    if (existingPlayer) {
      existingPlayer.ws = player.ws;
      existingPlayer.isConnected = true;
      existingPlayer.nickname = player.nickname || existingPlayer.nickname;
      existingPlayer.emoji = player.emoji || existingPlayer.emoji;
      this.playerRooms.set(player.id, roomCode);
      this.setPlayerConnection(player.id, player.ws);

      room.checkEmptyRoom();

      return room;
    }

    if (room.gameState === 'playing') throw new Error('游戏正在进行中，无法加入新玩家');
    const aiCount = room.settings?.aiPlayers ? room.settings.aiPlayers.length : 0;
    const totalPlayerCount = room.players.size + aiCount;
    if (totalPlayerCount >= 4) throw new Error('房间已满');

    this.cancelRoomDestroy(roomCode);

    if (room.gameState === 'finished') {
      room.gameState = 'waiting';
      room.gameSessionId = null;
      room.playerReadyStatus = new Map();
      room.postGameHostId = null;
      console.log(`房间 ${roomCode} 游戏已结束，重置为等待状态`);
    }

    if (room.players.size === 0) {
      room.host = player;
      player.isHost = true;
      console.log(`玩家 ${player.id} (${player.nickname}) 成为空房间 ${roomCode} 房主`);
    }

    room.addPlayer(player);
    room.playerReadyStatus.set(player.id, !!player.isHost);
    this.playerRooms.set(player.id, roomCode);
    return room;
  }

  listPublicRooms() {
    const summaries = [];
    for (const room of this.rooms.values()) {
      if (room.isPrivate) continue;

      const aiCount = room.settings?.aiPlayers ? room.settings.aiPlayers.length : 0;
      const totalPlayerCount = room.players.size + aiCount;
      if (totalPlayerCount === 0) continue;
      if (totalPlayerCount >= 4 && room.gameState !== 'playing') continue;

      summaries.push({
        code: room.code,
        name: room.name,
        pieceCount: room.settings?.pieceCount ?? 4,
        skillMode: !!(room.settings?.skillMode),
        happyMode: !!(room.settings?.happyMode),
        playerCount: totalPlayerCount,
        maxPlayers: 4,
        gameState: room.gameState,
        createdAt: room.createdAt,
        playerIds: Array.from(room.players.keys())
      });
    }

    summaries.sort((a, b) => b.createdAt - a.createdAt);
    return summaries;
  }

  /**
   * 统一房间延迟销毁入口。游戏中全员掉线的宽限、结算后空房的宽限都走这里，
   * 避免过去 Room 与 RoomManager 各持一个定时器互相覆盖。
   */
  scheduleRoomDestroy(roomCode, { delayMs = ROOM_LIFECYCLE.EMPTY_ROOM_DESTROY_MS, reason = 'empty', notice = null } = {}) {
    console.log(`房间 ${roomCode} 已空，启动${Math.round(delayMs / 60000)}分钟延迟销毁（${reason}）`);

    if (this.roomDestroyTimers.has(roomCode)) {
      clearTimeout(this.roomDestroyTimers.get(roomCode));
      this.roomDestroyTimers.delete(roomCode);
    }

    const entry = { reason, notice, startedAt: Date.now() };
    const timer = setTimeout(() => {
      const room = this.rooms.get(roomCode);
      // 判据是「有没有在线人类」而非「玩家表是否为空」：游戏中掉线的人仍留在表里等重连
      if (room && !room.hasHumanPlayers()) {
        console.log(`房间 ${roomCode} 延迟窗口内无人回来，销毁`);
        this._destroyRoom(roomCode);
      } else if (room) {
        console.log(`房间 ${roomCode} 延迟期间有人回来，取消销毁`);
      }
      this.roomDestroyTimers.delete(roomCode);
    }, delayMs);

    entry.timer = timer;
    this.roomDestroyTimers.set(roomCode, entry);

    if (notice && notice.type) {
      const room = this.rooms.get(roomCode);
      room?.broadcast(notice);
    }
  }

  cancelRoomDestroy(roomCode) {
    const entry = this.roomDestroyTimers.get(roomCode);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.roomDestroyTimers.delete(roomCode);
    console.log(`房间 ${roomCode} 取消延迟销毁`);
  }

  immediateDestroyRoom(roomCode) {
    if (this.roomDestroyTimers.has(roomCode)) {
      clearTimeout(this.roomDestroyTimers.get(roomCode));
      this.roomDestroyTimers.delete(roomCode);
    }
    this._destroyRoom(roomCode);
  }

  /** 唯一真正的删除实现：清理会话、房间与所有玩家映射 */
  _destroyRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    if (room.gameSessionId) {
      this.removeGameSession(room.gameSessionId);
      room.gameSessionId = null;
    }

    room.players.forEach((player) => {
      this.playerRooms.delete(player.id);
    });

    this.rooms.delete(roomCode);
    console.log(`房间 ${roomCode} 已销毁`);
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode);
  }

  getPlayerRoom(playerId) {
    const roomCode = this.playerRooms.get(playerId);
    return roomCode ? this.rooms.get(roomCode) : null;
  }

  createGameSession(gameSessionId, players, pieceCount = 4, roomCode = null, hostId = null, skillMode = false, happyMode = false) {
    console.log(`创建游戏会话: ${gameSessionId}, 玩家数: ${players.length}, 棋子数: ${pieceCount}, 欢乐模式: ${happyMode}`);
    const gameSession = new GameSession(gameSessionId, players, pieceCount, roomCode, hostId, skillMode, happyMode);
    this.gameSessions.set(gameSessionId, gameSession);
    players.forEach(player => {
      if (!player.isAI) {
        this.playerSessions.set(player.id, gameSessionId);
      }
    });
    return gameSession;
  }

  getGameSession(gameSessionId) {
    return this.gameSessions.get(gameSessionId);
  }

  getPlayerGameSession(playerId) {
    const gameSessionId = this.playerSessions.get(playerId);
    return gameSessionId ? this.getGameSession(gameSessionId) : null;
  }

  removeGameSession(gameSessionId) {
    const gameSession = this.gameSessions.get(gameSessionId);
    if (!gameSession) {
      console.log(`游戏会话 ${gameSessionId} 不存在，无需删除`);
      return;
    }

    console.log(`删除游戏会话: ${gameSessionId}`);

    gameSession.players.forEach((player, playerId) => {
      this.playerSessions.delete(playerId);
    });

    this.gameSessions.delete(gameSessionId);
    deps.dropAuthoritySession(gameSessionId);

    console.log(`游戏会话 ${gameSessionId} 已删除`);
  }

  setPlayerConnection(playerId, ws) {
    this.playerConnections.set(playerId, ws);
    if (deps.stats) {
      deps.stats.recordPlayerConnected(playerId);
      deps.stats.recordConnectionCount(this.playerConnections.size);
    }
  }

  getPlayerConnection(playerId) {
    return this.playerConnections.get(playerId);
  }

  // -------------------------- 重连冷却 --------------------------
  markRejoin(playerId, now = Date.now()) {
    this.rejoinCooldowns.set(playerId, now);
    this.pruneRejoinCooldowns(now);
  }

  getRejoinCooldown(playerId) {
    return this.rejoinCooldowns.get(playerId) || 0;
  }

  /** 冷却窗口只有 2 秒，超出即无意义，顺手清理防止长期运行内存增长 */
  pruneRejoinCooldowns(now = Date.now()) {
    const ttl = 60 * 1000;
    for (const [playerId, ts] of this.rejoinCooldowns) {
      if (now - ts > ttl) this.rejoinCooldowns.delete(playerId);
    }
  }

  clearPlayerTimers(playerId) {
    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId));
      this.disconnectTimers.delete(playerId);
    }
    if (this.disconnectDebounceTimers.has(playerId)) {
      clearTimeout(this.disconnectDebounceTimers.get(playerId));
      this.disconnectDebounceTimers.delete(playerId);
    }
  }
}

const manager = new RoomManager();

module.exports = {
  Player,
  GameSession,
  Room,
  RoomManager,
  roomManager: manager,
  ROOM_LIFECYCLE,
  ROOM_CHAT_MAX_MESSAGES,
  configureRoomManager
};
