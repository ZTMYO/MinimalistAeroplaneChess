import '../css/theme.css';
import '../css/admin.css';

class AdminPanel {
    constructor() {
        this.autoRefreshEnabled = true;
        this.refreshInterval = null;
        this.apiBaseUrl = window.location.origin;

        this.init();
    }

    init() {
        // 绑定事件
        document.getElementById('autoRefresh').addEventListener('change', (e) => {
            this.autoRefreshEnabled = e.target.checked;
            if (this.autoRefreshEnabled) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        });

        // 初始加载数据
        this.fetchAllData();

        // 启动自动刷新
        this.startAutoRefresh();

        // 窗口尺寸变了按当前数据重画一次折线图
        window.addEventListener('resize', () => {
            if (this.historyRows) this.renderHistoryChart();
        });
    }

    startAutoRefresh() {
        this.stopAutoRefresh();
        this.refreshInterval = setInterval(() => {
            if (this.autoRefreshEnabled) {
                this.fetchAllData();
            }
        }, 3000); // 每3秒刷新

        // 历史是读盘的数据，一分钟刷一次就够
        this.fetchHistory().catch(() => {});
        this.historyInterval = setInterval(() => {
            if (this.autoRefreshEnabled) this.fetchHistory().catch(() => {});
        }, 60000);
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.historyInterval) {
            clearInterval(this.historyInterval);
            this.historyInterval = null;
        }
    }

    async fetchAllData() {
        try {
            // 获取统计、房间、在线用户和每日数据
            const [statsData, roomsData, onlineUsersData, dailyStats] = await Promise.all([
                this.fetchStats(),
                this.fetchRooms(),
                this.fetchOnlineUsers(),
                this.fetchDailyStats()
            ]);

            // 更新界面
            this.updateStats(statsData);
            this.updateCombinedTable(roomsData);
            this.updateOnlineUsers(onlineUsersData);
            this.updateDailyStats(dailyStats);

            // 更新服务器状态
            this.setServerStatus('online');
        } catch (error) {
            console.error('获取数据失败:', error);
            this.setServerStatus('offline');
        }
    }

    async fetchStats() {
        const response = await fetch(`${this.apiBaseUrl}/api/stats`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return data.stats;
    }

    async fetchRooms() {
        const url = `${this.apiBaseUrl}/api/rooms`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.rooms;
    }

    async fetchOnlineUsers() {
        const url = `${this.apiBaseUrl}/api/online-users`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data.users;
    }

    updateStats(stats) {
        // 房间统计
        document.getElementById('totalRooms').textContent = stats.rooms.total;
        document.getElementById('waitingRooms').textContent = stats.rooms.waiting;
        document.getElementById('playingRooms').textContent = stats.rooms.playing;
        document.getElementById('finishedRooms').textContent = stats.rooms.finished || 0;

        // 游戏会话
        document.getElementById('totalSessions').textContent = stats.sessions.total;

        // 玩家统计
        document.getElementById('totalPlayers').textContent = stats.players.totalConnections;
        document.getElementById('playersInRooms').textContent = stats.players.inRooms;
        document.getElementById('playersInSessions').textContent = stats.players.inSessions;

        // 定时器统计 / 待清理房间统计
        document.getElementById('totalTimers').textContent = stats.rooms.cleanup || 0;
        document.getElementById('roomTimers').textContent = stats.timers.roomDestroyTimers;
        document.getElementById('disconnectTimers').textContent = stats.timers.disconnectTimers;
    }

    updateOnlineUsers(users) {
        const container = document.getElementById('onlineUsersContainer');
        if (!container) return;

        if (!users || users.length === 0) {
            container.innerHTML = '<div class="empty-message">当前无在线用户</div>';
            return;
        }

        container.innerHTML = users.map(user => {
            const statusMap = {
                'idle': '首页',
                'in_room': '房间中',
                'playing': '游戏中',
                'spectating': '观战中'
            };

            const statusText = statusMap[user.status] || user.status;
            const roomInfo = user.roomCode ? ` (${user.roomCode})` : '';

            return `
                <div class="user-tag status-${user.status}" title="ID: ${user.playerId}">
                    <span class="user-status-dot"></span>
                    <span class="user-nickname">${user.nickname}</span>
                    <span class="user-status-text">${statusText}${roomInfo}</span>
                </div>
            `;
        }).join('');
    }

    updateCombinedTable(rooms) {
        const grid = document.getElementById('combinedTableBody');

        if (!rooms || rooms.length === 0) {
            grid.innerHTML = '<p class="empty-message">暂无活跃房间</p>';
            return;
        }

        grid.innerHTML = rooms.map(room => {
            const session = room.gameSession;
            const badgeClass = room.displayState || room.gameState;
            const stateText = this.getGameStateText(room);


            // 2. 会话ID列
            let sessionIdInfo = '-';
            if (session) {
                const spectateUrl = `${window.location.origin}/spectate?room=${room.code}`;
                sessionIdInfo = `<a href="${spectateUrl}" target="_blank" class="session-id spectate-link" title="点击观战">${session.gameSessionId}</a>`;
            }

            // 3. 玩家数列
            const playerInfo = `${room.players.length}/4`;

            // 4. 在线状态列
            let onlineInfo = '-';
            if (session) {
                // 有游戏会话：使用会话数据统计真人玩家
                const realPlayers = session.players.filter(p => !p.isAI);
                const onlineRealPlayers = realPlayers.filter(p => p.isConnected || p.isAITakeover).length;
                const totalRealPlayers = realPlayers.length;
                const onlineClass = totalRealPlayers === 0 ? 'empty-room' : (onlineRealPlayers === totalRealPlayers ? 'all-online' : 'partial-online');
                onlineInfo = `<span class="online-status ${onlineClass}">${onlineRealPlayers}/${totalRealPlayers}</span>`;
            } else {
                // 无游戏会话：使用房间数据统计真人玩家
                const realPlayers = room.players.filter(p => !p.isAI);
                const onlineRealPlayers = realPlayers.filter(p => p.isConnected || p.isAITakeover).length;
                const totalRealPlayers = realPlayers.length;
                const onlineClass = totalRealPlayers === 0 ? 'empty-room' : (onlineRealPlayers === totalRealPlayers ? 'all-online' : 'partial-online');
                onlineInfo = `<span class="online-status ${onlineClass}">${onlineRealPlayers}/${totalRealPlayers}</span>`;
            }

            // 5. 当前回合列
            let turnInfo = '-';
            if (session && session.gameData && session.gameData.currentPlayer) {
                const currentPlayer = session.players.find(p => p.playerNumber === session.gameData.currentPlayer);
                if (currentPlayer) {
                    turnInfo = `<span class="player-badge player-${currentPlayer.playerNumber}">${currentPlayer.nickname}</span>`;
                }
            }

            // 6. 游戏时长
            let timeInfo = '-';
            if (session) {
                timeInfo = `<span class="duration">${this.formatDuration(session.createdAt)}</span>`;
            }

            // 7. 配置信息：模式写法跟游戏页标题一致（标准模式 / 道具模式，欢乐模式加后缀）
            let modeText = room.settings?.skillMode === true ? '道具模式' : '标准模式';
            if (room.settings?.happyMode === true) modeText += '·欢乐';
            const configInfo = [
                `<span class="room-config-item">${room.settings?.pieceCount || 4}棋子</span>`,
                `<span class="room-config-item">${modeText}</span>`
            ].join('');

            return `
                <article class="room-card">
                    <div class="room-card-head">
                        <span class="room-code">${room.code}</span>
                        <div class="room-card-tags">${configInfo}<span class="status-badge ${badgeClass}">${stateText}</span></div>
                    </div>
                    <div class="room-card-session">
                        <div class="room-fact"><span class="room-fact-label">会话</span><span class="room-fact-value">${sessionIdInfo}</span></div>
                        <div class="room-fact"><span class="room-fact-label">时长</span><span class="room-fact-value">${timeInfo}</span></div>
                    </div>
                    <div class="room-card-facts">
                        <div class="room-fact"><span class="room-fact-label">玩家</span><span class="room-fact-value">${playerInfo}</span></div>
                        <div class="room-fact"><span class="room-fact-label">在线</span><span class="room-fact-value">${onlineInfo}</span></div>
                        <div class="room-fact room-fact-wide"><span class="room-fact-label">回合</span><span class="room-fact-value">${turnInfo}</span></div>
                    </div>
                    <div class="room-card-players">${this.formatPlayersList(session ? session.players : room.players)}</div>
                </article>
            `;
        }).join('');
    }

    formatPlayersList(players) {
        if (!players || players.length === 0) return '-';

        // 按颜色（玩家编号）排序，确保展示顺序一致
        const sortedPlayers = [...players].sort((a, b) => (a.playerNumber || a.color) - (b.playerNumber || b.color));

        return sortedPlayers.map(p => {
            const playerNumber = p.playerNumber || p.color;
            // AI 玩家默认视为“在线”状态
            const isOnline = p.isAI || p.isConnected !== false;
            const statusClass = isOnline ? 'online' : 'offline';
            const typeClass = p.isAI ? 'ai' : 'human';
            
            const hostBadge = p.isHost ? '<span class="host-badge">房主</span>' : '';
            const aiBadge = p.isAI ? '<span class="host-badge" style="color:var(--text-gray);">AI</span>' : '';
            
            // 如果离线（且不是AI），使用灰色样式；否则显示颜色
            const playerColorClass = isOnline ? (playerNumber ? `player-${playerNumber}` : '') : 'offline-gray';

            return `<div class="player-item ${statusClass} ${typeClass} ${playerColorClass}">
                ${hostBadge}${aiBadge}
                <span class="player-name">${p.nickname}</span>
            </div>`;
        }).join('');
    }



    formatDuration(timestamp) {
        const now = Date.now();
        const diff = now - timestamp;

        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}小时${minutes % 60}分`;
        } else if (minutes > 0) {
            return `${minutes}分${seconds % 60}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    getGameStateText(room) {
        // 优先使用后端传来的逻辑展示状态
        if (room.displayState === 'cleanup') {
            return '待清理';
        }

        const stateMap = {
            'waiting': '等待中',
            'playing': '游戏中',
            'finished': '已结算'
        };
        return stateMap[room.gameState] || room.gameState;
    }


    setServerStatus(status) {
        const statusEl = document.getElementById('serverStatus');
        statusEl.className = `status-value ${status}`;
        statusEl.textContent = status === 'online' ? '在线' : '离线';
    }

    async fetchDailyStats() {
        const url = `${this.apiBaseUrl}/api/daily-stats`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        return data;
    }

    updateDailyStats(daily) {
        if (!daily) return;
        document.getElementById('statGamesValue').textContent = daily.gamesPlayed || 0;
        document.getElementById('statFinishedValue').textContent = daily.gamesFinished || 0;
        document.getElementById('statPlayersValue').textContent = daily.uniquePlayers || 0;
        document.getElementById('statPeakValue').textContent = daily.peakOnline || 0;
    }

    async fetchHistory() {
        const response = await fetch(`${this.apiBaseUrl}/api/daily-history?days=7`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const data = await response.json();
        this.updateHistory(data.days || []);
    }

    updateHistory(rows) {
        this.historyRows = rows;
        this.hoverIndex = -1;
        const chart = document.querySelector('.history-chart');
        if (chart) chart.style.display = rows.length ? '' : 'none';
        this.hideChartTooltip();
        this.renderHistoryChart();
        this.bindChartHover();
    }

    /* 四条折线（对局 / 完赛 / 玩家 / 峰值），配色沿用四位玩家的主题色 */
    chartSeries() {
        const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
        return [
            { key: 'gamesPlayed', label: '对局', legend: 'legend-1', color: cssVar('--player-1-color', '#E74C3C') },
            { key: 'gamesFinished', label: '完赛', legend: 'legend-2', color: cssVar('--player-2-color', '#3498DB') },
            { key: 'uniquePlayers', label: '玩家', legend: 'legend-3', color: cssVar('--player-3-color', '#2EC871') },
            { key: 'peakOnline', label: '峰值', legend: 'legend-4', color: cssVar('--player-4-color', '#F1C40F') }
        ];
    }

    /* 最近 7 天的走势图（含今天）；hover 那天时圆点放大并弹出数值 */
    renderHistoryChart() {
        const canvas = document.getElementById('historyChart');
        const rows = this.historyRows;
        if (!canvas || !rows || !rows.length) return;

        const cssVar = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
        const series = this.chartSeries();
        const data = rows.slice().reverse();

        const container = canvas.parentElement;
        const width = container.clientWidth || 380;
        const height = 120;
        const dpr = window.devicePixelRatio || 1;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.width = width * dpr;
        canvas.height = height * dpr;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        ctx.textBaseline = 'middle';
        ctx.font = '11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

        const padding = { top: 14, right: 12, bottom: 22, left: 34 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        const xStep = data.length > 1 ? chartWidth / (data.length - 1) : 0;

        const maxValue = Math.max(1, ...data.flatMap((row) => series.map((item) => Number(row[item.key]) || 0)));
        const step = this.niceStep(maxValue);
        const top = Math.ceil(maxValue / step) * step;
        const pointAt = (row, key, index) => ({
            x: padding.left + xStep * index,
            y: padding.top + chartHeight - ((Number(row[key]) || 0) / top) * chartHeight
        });
        this.chartLayout = { padding, chartWidth, chartHeight, xStep, data };

        // 横向网格 + Y 轴刻度
        ctx.strokeStyle = cssVar('--overlay-warm', 'rgba(200, 195, 185, 0.3)');
        ctx.fillStyle = cssVar('--text-primary', '#2d241f');
        ctx.textAlign = 'right';
        ctx.lineWidth = 1;
        for (let value = 0; value <= top; value += step) {
            const y = padding.top + chartHeight - (value / top) * chartHeight;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
            ctx.fillText(String(value), padding.left - 6, y);
        }

        // X 轴日期
        data.forEach((row, index) => {
            const label = String(row.date).slice(5);
            const x = padding.left + xStep * index;
            if (index === 0) {
                ctx.textAlign = 'left';
                ctx.fillText(label, padding.left, height - 10);
            } else if (index === data.length - 1) {
                ctx.textAlign = 'right';
                ctx.fillText(label, padding.left + chartWidth, height - 10);
            } else {
                ctx.textAlign = 'center';
                ctx.fillText(label, x, height - 10);
            }
        });

        // 折线 + 数据点（悬停那天的点放大一圈）
        series.forEach((item) => {
            const points = data.map((row, index) => pointAt(row, item.key, index));

            ctx.strokeStyle = item.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
            ctx.stroke();

            ctx.fillStyle = item.color;
            points.forEach((point, index) => {
                const hovered = index === this.hoverIndex;
                ctx.beginPath();
                ctx.arc(point.x, point.y, hovered ? 4 : 2.5, 0, Math.PI * 2);
                ctx.fill();
                if (hovered) {
                    ctx.strokeStyle = cssVar('--bg-soft', '#fffdfa');
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            });
        });
    }

    bindChartHover() {
        const canvas = document.getElementById('historyChart');
        if (!canvas || canvas.dataset.hoverBound) return;
        canvas.dataset.hoverBound = '1';

        canvas.addEventListener('mousemove', (event) => {
            const layout = this.chartLayout;
            const rows = this.historyRows || [];
            if (!layout || !rows.length) return;

            const rect = canvas.getBoundingClientRect();
            const offsetX = event.clientX - rect.left;
            const index = layout.xStep > 0
                ? Math.round((offsetX - layout.padding.left) / layout.xStep)
                : 0;
            const clamped = Math.min(Math.max(index, 0), layout.data.length - 1);
            if (clamped === this.hoverIndex) return;

            this.hoverIndex = clamped;
            this.renderHistoryChart();
            this.showChartTooltip(clamped);
        });

        canvas.addEventListener('mouseleave', () => {
            if (this.hoverIndex < 0) return;
            this.hoverIndex = -1;
            this.hideChartTooltip();
            this.renderHistoryChart();
        });
    }

    showChartTooltip(index) {
        const row = this.chartLayout && this.chartLayout.data[index];
        const tooltip = this.chartTooltip();
        if (!row || !tooltip) return;

        tooltip.innerHTML = `<b>${String(row.date).slice(5)}</b>`
            + this.chartSeries().map((item) => `<span><i class="legend-dot ${item.legend}"></i>${item.label} ${Number(row[item.key]) || 0}</span>`).join('');

        const container = tooltip.parentElement;
        const pointX = this.chartLayout.padding.left + this.chartLayout.xStep * index;
        tooltip.style.display = 'block';
        const half = tooltip.offsetWidth / 2;
        tooltip.style.left = `${Math.min(Math.max(pointX, half + 2), container.clientWidth - half - 2)}px`;
    }

    hideChartTooltip() {
        const tooltip = document.querySelector('.chart-tooltip');
        if (tooltip) tooltip.style.display = 'none';
    }

    chartTooltip() {
        let tooltip = document.querySelector('.chart-tooltip');
        if (tooltip) return tooltip;
        const chart = document.querySelector('.history-chart');
        if (!chart) return null;
        tooltip = document.createElement('div');
        tooltip.className = 'chart-tooltip';
        chart.appendChild(tooltip);
        return tooltip;
    }

    niceStep(max) {
        const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000];
        return steps.find((step) => max / step <= 4) || Math.ceil(max / 4);
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new AdminPanel();
});

