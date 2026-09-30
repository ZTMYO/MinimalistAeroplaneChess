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
    }

    startAutoRefresh() {
        this.stopAutoRefresh();
        this.refreshInterval = setInterval(() => {
            if (this.autoRefreshEnabled) {
                this.fetchAllData();
            }
        }, 3000); // 每3秒刷新
    }

    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
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
        const tbody = document.getElementById('combinedTableBody');

        if (!rooms || rooms.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="empty-message">暂无活跃房间</td></tr>';
            return;
        }

        tbody.innerHTML = rooms.map(room => {
            const session = room.gameSession;
            const badgeClass = room.displayState || room.gameState;
            const stateText = this.getGameStateText(room);

            // 1. 房间号列
            const roomCodeInfo = `<span class="room-code">${room.code}</span>`;

            // 2. 会话ID列
            let sessionIdInfo = '-';
            if (session) {
                const spectateUrl = `${window.location.origin}/spectate?room=${room.code}`;
                sessionIdInfo = `<a href="${spectateUrl}" target="_blank" class="session-id spectate-link" 
                                  style="font-size:11px; padding:2px 6px;" title="点击观战">${session.gameSessionId}</a>`;
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
                onlineInfo = `<span class="online-status ${onlineClass}" style="padding:2px 6px; font-size:11px;">${onlineRealPlayers}/${totalRealPlayers}</span>`;
            } else {
                // 无游戏会话：使用房间数据统计真人玩家
                const realPlayers = room.players.filter(p => !p.isAI);
                const onlineRealPlayers = realPlayers.filter(p => p.isConnected || p.isAITakeover).length;
                const totalRealPlayers = realPlayers.length;
                const onlineClass = totalRealPlayers === 0 ? 'empty-room' : (onlineRealPlayers === totalRealPlayers ? 'all-online' : 'partial-online');
                onlineInfo = `<span class="online-status ${onlineClass}" style="padding:2px 6px; font-size:11px;">${onlineRealPlayers}/${totalRealPlayers}</span>`;
            }

            // 5. 当前回合列
            let turnInfo = '-';
            if (session && session.gameData && session.gameData.currentPlayer) {
                const currentPlayer = session.players.find(p => p.playerNumber === session.gameData.currentPlayer);
                if (currentPlayer) {
                    turnInfo = `<span class="player-badge player-${currentPlayer.playerNumber}">${currentPlayer.nickname}</span>`;
                }
            }

            // 6. 游戏时长列
            let timeInfo = '-';
            if (session) {
                timeInfo = `<div class="duration" style="font-size:13px; font-weight:bold;">
                    ${this.formatDuration(session.createdAt)}</div>`;
            }

            // 7. 配置信息列
            const configInfo = `<div style="font-size:12px; color:var(--text-primary);">
                棋子${room.settings?.pieceCount || 4} 道具${room.settings?.skillMode ? '开' : '关'} 欢乐${room.settings?.happyMode ? '开' : '关'}
            </div>`;

            return `
                <tr>
                    <td>${roomCodeInfo}</td>
                    <td>${sessionIdInfo}</td>
                    <td><span class="status-badge ${badgeClass}">${stateText}</span></td>
                    <td>${playerInfo}</td>
                    <td>${onlineInfo}</td>
                    <td>${turnInfo}</td>
                    <td>${timeInfo}</td>
                    <td>${configInfo}</td>
                    <td>${this.formatPlayersList(session ? session.players : room.players)}</td>
                </tr>
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
        document.getElementById('statGames').textContent = `对局 ${daily.gamesPlayed || 0}`;
        document.getElementById('statFinished').textContent = `完赛 ${daily.gamesFinished || 0}`;
        document.getElementById('statPlayers').textContent = `玩家 ${daily.uniquePlayers || 0}`;
        document.getElementById('statPeak').textContent = `峰值 ${daily.peakOnline || 0}`;
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    new AdminPanel();
});

