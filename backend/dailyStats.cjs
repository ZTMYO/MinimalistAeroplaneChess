/**
 * 每日统计：对局 / 完赛 / 独立玩家 / 在线峰值。
 *
 * 项目没有数据库，全部历史就存在一个文件里：backend/data/stats.json
 *   { "days": { "2026-10-01": { gamesPlayed, gamesFinished, peakOnline, roomsCreated, uniquePlayers: [...] } } }
 * 60 秒落一次盘，跨天和进程退出时也落，启动时把今天的读回来接着记，
 * 所以 PM2 重启、部署都不会把当天数据打断。写入是「先写 .tmp 再改名」。
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.resolve(__dirname, 'data/stats.json');
const SAVE_INTERVAL_MS = 60 * 1000;
const KEEP_DAYS = 90;

function dayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

class DailyStats {
  constructor() {
    this.days = {};
    this.reset();
    this.load();
    this.scheduleMidnightReset();

    this.saveTimer = setInterval(() => this.tick(), SAVE_INTERVAL_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();

    const flush = () => this.save();
    process.on('SIGINT', flush);
    process.on('SIGTERM', flush);
    process.on('exit', flush);
  }

  reset() {
    this.date = dayKey();
    this.gamesPlayed = 0;
    this.gamesFinished = 0;
    this.peakOnline = 0;
    this.roomsCreated = 0;
    this.uniquePlayers = new Set();
  }

  /* 计数与定时落盘前都先确认还是不是同一天 */
  ensureToday() {
    if (dayKey() !== this.date) this.rollover();
  }

  /* 跨天：把昨天收进历史，开新的一天 */
  rollover() {
    this.days[this.date] = this.snapshot();
    this.reset();
    this.prune();
    this.save();
  }

  tick() {
    this.ensureToday();
    this.save();
  }

  scheduleMidnightReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    this.resetTimer = setTimeout(() => {
      this.rollover();
      this.scheduleMidnightReset();
    }, tomorrow - now);
    if (this.resetTimer.unref) this.resetTimer.unref();
  }

  /* 当天的数据（含玩家 id 集合，跨重启也不会重复计数） */
  snapshot() {
    return {
      gamesPlayed: this.gamesPlayed,
      gamesFinished: this.gamesFinished,
      peakOnline: this.peakOnline,
      roomsCreated: this.roomsCreated,
      uniquePlayers: [...this.uniquePlayers]
    };
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data && data.days && typeof data.days === 'object') this.days = data.days;

      const today = this.days[this.date];
      if (today) {
        this.gamesPlayed = today.gamesPlayed || 0;
        this.gamesFinished = today.gamesFinished || 0;
        this.peakOnline = today.peakOnline || 0;
        this.roomsCreated = today.roomsCreated || 0;
        this.uniquePlayers = new Set(Array.isArray(today.uniquePlayers) ? today.uniquePlayers : []);
      }
      console.log(`[统计] 已有 ${Object.keys(this.days).length} 天记录；今天：对局 ${this.gamesPlayed}｜完赛 ${this.gamesFinished}｜玩家 ${this.uniquePlayers.size}｜峰值 ${this.peakOnline}`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('[统计] 读取失败:', error.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const payload = JSON.stringify({ days: { ...this.days, [this.date]: this.snapshot() } });
      const temp = `${DATA_FILE}.tmp`;
      fs.writeFileSync(temp, payload);
      fs.renameSync(temp, DATA_FILE);
    } catch (error) {
      console.error('[统计] 写入失败（不影响对局）:', error.message);
    }
  }

  /* 只留最近 KEEP_DAYS 天 */
  prune() {
    const keys = Object.keys(this.days).sort();
    keys.slice(0, Math.max(0, keys.length - KEEP_DAYS)).forEach((key) => {
      delete this.days[key];
    });
  }

  /* 最近若干天，最新在前；今天这一行用内存里的实时值 */
  history(days = 7) {
    const keys = Object.keys(this.days).filter((key) => key !== this.date).sort().slice(-(days - 1));
    const rows = keys.map((key) => {
      const row = this.days[key] || {};
      return {
        date: key,
        gamesPlayed: row.gamesPlayed || 0,
        gamesFinished: row.gamesFinished || 0,
        peakOnline: row.peakOnline || 0,
        roomsCreated: row.roomsCreated || 0,
        uniquePlayers: Array.isArray(row.uniquePlayers) ? row.uniquePlayers.length : (row.uniquePlayers || 0)
      };
    });
    rows.push(this.toJSON());
    return rows.reverse();
  }

  recordGameStarted() {
    this.ensureToday();
    this.gamesPlayed += 1;
  }

  recordGameFinished() {
    this.ensureToday();
    this.gamesFinished += 1;
  }

  recordRoomCreated() {
    this.ensureToday();
    this.roomsCreated += 1;
  }

  recordPlayerConnected(playerId) {
    this.ensureToday();
    this.uniquePlayers.add(playerId);
  }

  recordConnectionCount(count) {
    if (count > this.peakOnline) this.peakOnline = count;
  }

  toJSON() {
    return {
      date: this.date,
      gamesPlayed: this.gamesPlayed,
      gamesFinished: this.gamesFinished,
      peakOnline: this.peakOnline,
      roomsCreated: this.roomsCreated,
      uniquePlayers: this.uniquePlayers.size
    };
  }
}

module.exports = { DailyStats };
