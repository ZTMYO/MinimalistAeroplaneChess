import { playerNameManager } from './playerNameManager.js';
import { activePlayerManager } from './activePlayerManager.js';
import { reconnectManager } from './reconnectManager.js';
import { titleManager } from './titleManager.js';
import { aiTakeoverManager } from './aiTakeoverManager.js';

function getDisplayName(player) {
    const cleanName = aiTakeoverManager?.originalNames?.[player];
    if (cleanName) return cleanName;
    return playerNameManager.getPlayerName(player) || `玩家${player}`;
}

class SettlementModal {
    constructor() {
        this.modal = null;
        this.rankingsContainer = null;
        this.dataAnalysisContainer = null;
        this.closeBtn = null;
        this.newGameBtn = null;
        this.dataAnalysisBtn = null;
        this.gameState = null;
        this.defeatCountDisplay = null;
        this.progressDisplay = null;
        this.currentView = 'rankings'; // 'rankings' 或 'dataAnalysis'

        this.init();
    }

    init() {
        this.modal = document.getElementById('settlement-modal');
        this.rankingsContainer = document.getElementById('settlement-rankings');
        this.dataAnalysisContainer = document.getElementById('settlement-data-analysis');
        this.closeBtn = document.getElementById('settlement-close');
        this.newGameBtn = document.getElementById('new-game-btn');
        this.dataAnalysisBtn = document.getElementById('data-analysis-btn');

        if (this.newGameBtn) {
            // 按钮文字由 HTML 模板决定，不再动态覆盖
            // game.html: 返回房间 | spectate.html: 返回主页
        }

        this.bindEvents();
    }

    bindEvents() {
        // 关闭按钮事件
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => {
                this.hide(); // 只关闭面板，不重置游戏
            });
        }

        // 返回房间按钮事件
        if (this.newGameBtn) {
            this.newGameBtn.addEventListener('click', () => {
                // 观战模式直接返回主页
                const isSpectator = window.gameInstance?.multiplayerGameManager?.isSpectator;
                if (isSpectator) {
                    window.location.href = '/';
                    return;
                }
                this.returnToRoom();
            });
        }

        // 数据分析按钮事件
        if (this.dataAnalysisBtn) {
            this.dataAnalysisBtn.addEventListener('click', () => {
                this.toggleView();
            });
        }

        // ESC键关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isVisible()) {
                this.hide(); // ESC键只关闭面板，不重置游戏
            }
        });
    }


    /**
     * 设置依赖的对象引用
     */
    setDependencies(gameState, defeatCountDisplay, progressDisplay) {
        this.gameState = gameState;
        this.defeatCountDisplay = defeatCountDisplay;
        this.progressDisplay = progressDisplay;
    }

    /**
     * 显示结算模态框
     * @param {number} winnerPlayer - 获胜玩家编号
     */
    show(winnerPlayer) {
        if (!this.modal || !this.gameState) return;

        // 防止重复调用（避免双音效和重复渲染）
        if (this.isVisible()) {
            console.log('[结算] show() 被重复调用，已跳过');
            return;
        }

        // 确保结算时至少保存一次完成度快照，避免折线图为空
        if (typeof this.gameState.saveProgressSnapshot === 'function') {
            try {
                this.gameState.saveProgressSnapshot();
            } catch (e) {
                // ignore
            }
        }

        // 播放游戏结束音效
        if (window.audioManager && window.audioManager.playGameOverSound) {
            window.audioManager.playGameOverSound();
        }

        // 重置视图为战绩
        this.currentView = 'rankings';
        this.updateViewDisplay();

        // 生成排名数据
        const rankingsData = this.generateRankingsData(winnerPlayer);

        // 计算称号（自动结算也要算，否则战绩卡与称号一览都没有称号）
        const playerTitles = titleManager.calculateTitles(this.gameState, rankingsData);
        rankingsData.forEach(data => {
            data.title = playerTitles[data.player];
        });
        this.playerTitles = playerTitles;

        // 渲染排名列表
        this.renderRankings(rankingsData);

        // 结算弹框模式标记
        this._updateModeLabel();

        // 更新时间戳
        this.updateTimestamp();

        // 显示模态框
        this.modal.classList.add('show');

        // 触发依次翻转动画
        this.triggerSequentialFlip();

        // 防止背景滚动
        document.body.style.overflow = 'hidden';
    }

    /**
     * 触发依次翻转动画
     */
    triggerSequentialFlip() {
        const cards = this.rankingsContainer.querySelectorAll('.flip-card');
        cards.forEach((card, index) => {
            setTimeout(() => {
                card.classList.remove('is-flipped');
            }, 600 + (index * 400)); // 1200ms后开始第一个，后续每隔400ms翻转一个
        });
    }

    /**
     * 显示结算模态框（带自定义排名数据）
     * @param {Array} rankings - 自定义排名数据
     */
    showWithRankings(rankings) {
        if (!this.modal) return;

        // 防止重复调用
        if (this.isVisible()) {
            console.log('[结算] showWithRankings() 被重复调用，已跳过');
            return;
        }

        // 确保结算时至少保存一次完成度快照，避免折线图为空
        if (this.gameState && typeof this.gameState.saveProgressSnapshot === 'function') {
            try {
                this.gameState.saveProgressSnapshot();
            } catch (e) {
                // ignore
            }
        }

        // 重置视图为战绩
        this.currentView = 'rankings';
        this.updateViewDisplay();

        // 基础排名数据
        const rankingsData = rankings.map((ranking, index) => ({
            player: ranking.playerNumber,
            playerName: ranking.playerName,
            progress: ranking.progressPercentage,
            defeatCounts: ranking.defeatCounts || {}, // 使用传入的击败次数数据，如果没有则使用空对象
            finishedCount: ranking.finishedCount,
            position: index + 1
        }));

        // 计算称号
        const playerTitles = titleManager.calculateTitles(this.gameState, rankingsData);
        rankingsData.forEach(data => {
            data.title = playerTitles[data.player];
        });
        // 数据分析面板底部要按玩家列出全部称号
        this.playerTitles = playerTitles;

        // 渲染排名列表
        this.renderRankings(rankingsData);

        // 结算弹框模式标记
        this._updateModeLabel();

        // 更新时间戳
        this.updateTimestamp();

        // 显示模态框
        this.modal.classList.add('show');

        // 触发依次翻转动画
        this.triggerSequentialFlip();

        // 防止背景滚动
        document.body.style.overflow = 'hidden';
    }

    /**
     * 隐藏结算模态框
     */
    hide() {
        if (!this.modal) return;

        this.modal.classList.remove('show');
        document.body.style.overflow = '';

        // 清除称号轮播定时器
        if (this._carouselTimer) {
            clearInterval(this._carouselTimer);
            this._carouselTimer = null;
        }

        // 重置视图为战绩
        this.currentView = 'rankings';
        this.updateViewDisplay();
    }

    /**
     * 切换视图（战绩/数据分析）
     */
    toggleView() {
        if (this.currentView === 'rankings') {
            this.currentView = 'dataAnalysis';
            this.renderDataAnalysis();
        } else {
            this.currentView = 'rankings';
        }
        this.updateViewDisplay();
    }

    /**
     * 更新视图显示
     */
    updateViewDisplay() {
        if (this.currentView === 'rankings') {
            // 显示战绩，隐藏数据分析
            if (this.rankingsContainer) {
                this.rankingsContainer.style.display = 'flex';
            }
            if (this.dataAnalysisContainer) {
                this.dataAnalysisContainer.style.display = 'none';
            }
            if (this.dataAnalysisBtn) {
                this.dataAnalysisBtn.textContent = '数据分析';
            }
        } else {
            // 显示数据分析，隐藏战绩
            if (this.rankingsContainer) {
                this.rankingsContainer.style.display = 'none';
            }
            if (this.dataAnalysisContainer) {
                this.dataAnalysisContainer.style.display = 'flex';
            }
            if (this.dataAnalysisBtn) {
                this.dataAnalysisBtn.textContent = '战绩查看';
            }
        }
    }

    /**
     * 渲染数据分析内容
     */
    renderDataAnalysis() {
        if (!this.dataAnalysisContainer || !this.gameState) return;

        let html = '';

        // 渲染完成度折线图
        html += this.renderProgressChart();

        // 渲染前进距离统计
        html += this.renderDistanceStatistics();

        // 渲染反弹格数统计
        html += this.renderBounceStatistics();

        // 渲染道具模式统计
        html += this.renderSkillStatistics();

        // 渲染骰子投掷统计表格
        html += this.renderDiceStatistics();

        // 渲染称号一览（放在面板最底下）
        html += this.renderTitleStatistics();

        this.dataAnalysisContainer.innerHTML = html;

        // 在DOM更新后绘制Canvas折线图
        setTimeout(() => {
            this.drawProgressChart();
            this.adjustTableHeaderFontSize();
        }, 0);
    }

    /**
     * 统计表表头字号自适应：人多或名字长时收小，免得表头换行把表格撑破。
     */
    adjustTableHeaderFontSize() {
        const container = this.dataAnalysisContainer;
        if (!container) return;

        const headers = container.querySelectorAll('.dice-stats-table th');
        if (!headers.length) return;

        const players = activePlayerManager.getActivePlayers();
        const longestName = players.reduce((max, player) => {
            const name = getDisplayName(player) || '';
            return Math.max(max, name.length);
        }, 0);
        const crowded = players.length >= 4 || longestName > 6;

        headers.forEach((th) => {
            th.style.fontSize = crowded ? '11px' : '';
        });
    }

    /**
     * 渲染完成度折线图区域
     */
    renderProgressChart() {
        if (!this.gameState.progressHistory || this.gameState.progressHistory.length === 0) {
            return '';
        }

        return `
            <div class="progress-chart-section">
                <h4 class="chart-title">完成度变化趋势</h4>
                <div class="chart-container">
                    <canvas id="progress-chart-canvas"></canvas>
                </div>
            </div>
        `;
    }

    /**
     * 绘制完成度折线图
     */
    drawProgressChart() {
        const canvas = document.getElementById('progress-chart-canvas');
        if (!canvas || !this.gameState.progressHistory || this.gameState.progressHistory.length === 0) {
            return;
        }

        const ctx = canvas.getContext('2d');
        const container = canvas.parentElement;
        const history = this.gameState.progressHistory;

        const minPointSpacing = 5;
        const calculatedWidth = Math.max(container.clientWidth, history.length * minPointSpacing + 60);

        const width = calculatedWidth;
        const height = 240;
        
        // 支持高DPI显示
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        
        // 设置显示尺寸
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        
        // 设置实际渲染尺寸（支持高DPI）
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        
        // 缩放上下文以匹配设备像素比
        ctx.scale(dpr, dpr);
        
        // 改善文本渲染质量
        ctx.textBaseline = 'middle';
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const padding = { top: 20, right: 5, bottom: 40, left: 50 };
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;

        const activePlayers = activePlayerManager.getActivePlayers();

        // 图表配色统一从 CSS 变量读，主题切换后重绘即可跟随
        const cssColor = (name, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);

        // 获取玩家颜色（从CSS变量读取）
        const playerColors = {
            1: getComputedStyle(document.documentElement).getPropertyValue('--player-1-color').trim() || '#E74C3C',
            2: getComputedStyle(document.documentElement).getPropertyValue('--player-2-color').trim() || '#3498DB',
            3: getComputedStyle(document.documentElement).getPropertyValue('--player-3-color').trim() || '#2ECC71',
            4: getComputedStyle(document.documentElement).getPropertyValue('--player-4-color').trim() || '#F1C40F'
        };

        // 清空画布
        ctx.clearRect(0, 0, width, height);

        // 绘制背景网格
        ctx.strokeStyle = cssColor('--overlay-warm', 'rgba(200, 195, 185, 0.3)');
        ctx.lineWidth = 1;
        for (let i = 0; i <= 10; i++) {
            const y = padding.top + (chartHeight / 10) * i;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
        }

        // 绘制Y轴标签（0-100%）
        ctx.fillStyle = cssColor('--text-primary', '#2d241f');
        ctx.font = '12px Arial';
        ctx.textAlign = 'right';
        for (let i = 0; i <= 10; i++) {
            const y = padding.top + (chartHeight / 10) * i;
            const value = 100 - i * 10;
            ctx.fillText(`${value}%`, padding.left - 15, y + 4);
        }

        // 绘制每个玩家的折线
        const xStep = chartWidth / Math.max(history.length - 1, 1);
        activePlayers.forEach(player => {
            ctx.strokeStyle = playerColors[player];
            ctx.lineWidth = 2.5;
            ctx.beginPath();

            history.forEach((snapshot, index) => {
                const progress = snapshot.players[player] || 0;
                const x = padding.left + xStep * index;
                const y = padding.top + chartHeight - (progress / 100) * chartHeight;

                if (index === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });

            ctx.stroke();
        });

        // 绘制图例
        const legendX = padding.left + 10;
        const legendY = padding.top + 10;
        activePlayers.forEach((player, index) => {
            const playerName = getDisplayName(player);
            const y = legendY + index * 20;

            // 绘制线条
            ctx.strokeStyle = playerColors[player];
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(legendX, y - 4.5);
            ctx.lineTo(legendX + 15, y - 4.5);
            ctx.stroke();

            // 绘制文字
            ctx.fillStyle = '#2d241f';
            ctx.font = '12px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(playerName, legendX + 20, y);
        });
    }

    /**
     * 渲染称号一览：每位玩家一行，列出本局获得的全部称号
     */
    renderTitleStatistics() {
        const titlesByPlayer = this.playerTitles;
        if (!titlesByPlayer) return '';

        const activePlayers = activePlayerManager.getActivePlayers();
        const tierRank = titleManager.TIER_RANK || {};
        const rows = activePlayers.map((player) => {
            const titles = [...(titlesByPlayer[player] || [])]
                .sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));
            const chips = titles.length
                ? titles.map((t) => {
                    const tier = titleManager.TIER_NAMES?.[t.tier] || '普通';
                    const fallback = t.id === 'default' ? ' title-chip-default' : '';
                    return `<span class="title-chip tier-${t.tier || 'common'}${fallback}" title="${tier}｜${t.desc || ''}">${t.name}</span>`;
                }).join('')
                : '<span class="title-chip title-chip-empty">暂无</span>';
            return `
                <div class="title-list-row">
                    <div class="title-list-who">
                        <span class="title-list-player player-text player-${player}">${getDisplayName(player)}</span>
                        <span class="title-list-count">${titles.length} 个</span>
                    </div>
                    <div class="title-list-chips">${chips}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="title-list-section">
                <h4 class="chart-title">称号一览</h4>
                <div class="title-list">${rows}</div>
            </div>
        `;
    }

    /**
     * 渲染骰子投掷统计表格
     */
    renderDiceStatistics() {
        const diceStats = this.gameState.diceStatistics;
        if (!diceStats) {
            return '<p class="no-data">暂无投掷数据</p>';
        }

        // 获取激活的玩家列表
        const activePlayers = activePlayerManager.getActivePlayers();
        const diceSymbols = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

        let html = '<div class="dice-stats-section">';
        html += '<h4 class="chart-title">骰子投掷统计</h4>';
        html += '<table class="dice-stats-table">';

        // 表头
        html += '<thead><tr>';
        html += '<th class="dice-header">点数</th>';
        activePlayers.forEach(player => {
            const playerName = getDisplayName(player);
            html += `<th class="player-header player-${player}">${playerName}</th>`;
        });
        html += '</tr></thead>';

        // 表体
        html += '<tbody>';
        for (let diceValue = 1; diceValue <= 6; diceValue++) {
            // 计算该点数的总投掷次数（所有玩家）
            let totalCountForDice = 0;
            const playerCounts = {};

            activePlayers.forEach(player => {
                const count = diceStats[player]?.[diceValue] || 0;
                playerCounts[player] = count;
                totalCountForDice += count;
            });

            // 找出最高次数和最低次数
            const counts = Object.values(playerCounts);
            const maxCount = Math.max(...counts);
            const minCount = Math.min(...counts);

            // 统计最高和最低的玩家数量
            const maxCountPlayers = counts.filter(c => c === maxCount).length;
            const minCountPlayers = counts.filter(c => c === minCount).length;

            // 只有当最高的只有一个玩家，或最低的只有一个玩家时，才高亮最高者
            const shouldHighlight = (maxCountPlayers === 1 || minCountPlayers === 1) && totalCountForDice > 0;

            html += '<tr>';
            html += `<td class="dice-cell">${diceSymbols[diceValue - 1]}</td>`;

            activePlayers.forEach(player => {
                const count = playerCounts[player];
                const percentage = totalCountForDice > 0 ? ((count / totalCountForDice) * 100).toFixed(1) : 0;
                const isHighest = shouldHighlight && count === maxCount && count > 0;
                const highlightClass = isHighest ? 'highlight' : '';

                html += `<td class="player-cell player-${player} ${highlightClass}">
                    <span class="count">${count}</span>
                    <span class="percentage">${percentage}%</span>
                </td>`;
            });

            html += '</tr>';
        }

        html += '</tbody>';
        html += '</table>';
        html += '</div>';

        return html;
    }

    /**
     * 渲染前进距离统计（水平条）
     */
    renderDistanceStatistics() {
        if (!this.gameState) return '';

        const activePlayers = activePlayerManager.getActivePlayers();
        const distances = activePlayers.map(player => ({
            player,
            distance: this.gameState.getTotalDistance(player),
            playerName: getDisplayName(player)
        }));

        // 按移动步数从大到小排序
        distances.sort((a, b) => b.distance - a.distance);

        // 找出最大值用于计算百分比宽度
        const maxDistance = Math.max(...distances.map(d => d.distance), 1); // 至少为1避免除零

        let html = '<div class="distance-stats-section">';
        html += '<h4 class="chart-title">前进格数统计</h4>';
        html += '<div class="distance-bars-container">';

        distances.forEach(item => {
            const percentage = (item.distance / maxDistance) * 100;
            html += `
                <div class="distance-bar-item">
                    <div class="distance-player-info">
                        <span class="distance-player-name player-${item.player}">${item.playerName}</span>
                        <span class="distance-value">${item.distance} <small>格</small></span>
                    </div>
                    <div class="distance-bar-bg">
                        <div class="distance-bar-fill player-${item.player}" style="width: ${percentage}%"></div>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        html += '</div>';

        return html;
    }

    /**
     * 渲染反弹格数统计（水平条）
     */
    renderBounceStatistics() {
        if (!this.gameState || !this.gameState.titleStats || !this.gameState.titleStats.bounceSteps) return '';

        const activePlayers = activePlayerManager.getActivePlayers();
        const bounces = activePlayers.map(player => ({
            player,
            steps: this.gameState.titleStats.bounceSteps[player] || 0,
            playerName: getDisplayName(player)
        }));

        // 按反弹步数从大到小排序
        bounces.sort((a, b) => b.steps - a.steps);

        // 找出最大值用于计算百分比宽度
        const maxSteps = Math.max(...bounces.map(b => b.steps), 1); // 至少为1避免除零

        let html = '<div class="distance-stats-section bounce-stats-section">';
        html += '<h4 class="chart-title">反弹总格数统计</h4>';
        html += '<div class="distance-bars-container">';

        bounces.forEach(item => {
            const percentage = (item.steps / maxSteps) * 100;
            html += `
                <div class="distance-bar-item">
                    <div class="distance-player-info">
                        <span class="distance-player-name player-${item.player}">${item.playerName}</span>
                        <span class="distance-value">${item.steps} <small>格</small></span>
                    </div>
                    <div class="distance-bar-bg">
                        <div class="distance-bar-fill player-${item.player}" style="width: ${percentage}%"></div>
                    </div>
                </div>
            `;
        });

        html += '</div>';
        html += '</div>';

        return html;
    }

    /**
     * 渲染道具模式统计数据（积分获取 + 各道具使用次数）
     * 仅在道具模式下显示
     */
    renderSkillStatistics() {
        // 从 window 或 gameInstance 获取 energyManager（观战模式 vs 游戏模式）
        const energyMgr = window.energyManager || window.gameInstance?.energyManager;
        if (!this.gameState || !energyMgr || !energyMgr.isSkillModeEnabled()) return '';

        const activePlayers = activePlayerManager.getActivePlayers();
        const gameState = this.gameState;

        // 积分获取条形图
        const energyItems = activePlayers.map(player => ({
            player,
            value: Math.floor(gameState.totalEnergyGained[player] || 0),
            playerName: getDisplayName(player)
        }));
        energyItems.sort((a, b) => b.value - a.value);
        const maxEnergy = Math.max(...energyItems.map(e => e.value), 1);

        let html = '<div class="distance-stats-section skill-stats-section">';

        // -- 积分获取 --
        html += '<h4 class="chart-title">积分获取统计</h4>';
        html += '<div class="distance-bars-container">';
        energyItems.forEach(item => {
            const percentage = (item.value / maxEnergy) * 100;
            html += `
                <div class="distance-bar-item">
                    <div class="distance-player-info">
                        <span class="distance-player-name player-${item.player}">${item.playerName}</span>
                        <span class="distance-value">${item.value} <small>分</small></span>
                    </div>
                    <div class="distance-bar-bg">
                        <div class="distance-bar-fill player-${item.player}" style="width: ${percentage}%"></div>
                    </div>
                </div>
            `;
        });
        html += '</div>';

        // -- 各道具使用次数（转置表格，参考骰子统计表格样式）--
        // 从DOM中获取道具SVG图标
        const skillIcons = {};
        ['remote-dice', 'teleport', 'polyhedral-dice', 'mysteryBox'].forEach(skillId => {
            const el = document.querySelector(`.skill-item[data-skill="${skillId}"] .skill-icon-container`);
            if (el) {
                const svg = el.querySelector('svg');
                if (svg) {
                    // 克隆避免影响原始DOM，转成HTML字符串
                    skillIcons[skillId] = svg.cloneNode(true).outerHTML;
                }
            }
        });

        const skillNames = [
            { key: 'remoteDice', skillId: 'remote-dice' },
            { key: 'teleport', skillId: 'teleport' },
            { key: 'polyhedralDice', skillId: 'polyhedral-dice' },
            { key: 'mysteryBox', skillId: 'mysteryBox' }
        ];

        html += '<h4 class="chart-title">道具使用统计</h4>';
        html += '<table class="dice-stats-table">';

        // 表头：玩家列
        html += '<thead><tr>';
        html += '<th class="dice-header">道具</th>';
        activePlayers.forEach(player => {
            const playerName = getDisplayName(player);
            html += `<th class="player-header player-${player}">${playerName}</th>`;
        });
        html += '</tr></thead>';

        // 表体：每行一种道具
        html += '<tbody>';
        skillNames.forEach(skill => {
            // 找出该道具使用最多的玩家
            let maxCount = 0;
            const playerCounts = {};
            activePlayers.forEach(player => {
                const count = (gameState.skillUsage[player]?.[skill.key] || 0);
                playerCounts[player] = count;
                if (count > maxCount) maxCount = count;
            });
            const maxCountPlayers = activePlayers.filter(p => playerCounts[p] === maxCount);
            const shouldHighlight = maxCountPlayers.length === 1 && maxCount > 0;

            const iconHtml = skillIcons[skill.skillId] || '';
            html += '<tr>';
            html += `<td class="dice-cell skill-icon-cell">${iconHtml}</td>`;
            activePlayers.forEach(player => {
                const count = playerCounts[player];
                const highlightClass = shouldHighlight && count === maxCount ? ' highlight' : '';
                html += `<td class="player-cell player-${player}${highlightClass}">
                    <span class="count">${count}</span>
                </td>`;
            });
            html += '</tr>';
        });

        // 合计行
        // 先计算所有玩家的合计，找出最大者
        const playerTotals = {};
        let maxTotal = 0;
        activePlayers.forEach(player => {
            const usage = gameState.skillUsage[player] || {};
            const total = (usage.remoteDice || 0) + (usage.teleport || 0)
                + (usage.polyhedralDice || 0) + (usage.mysteryBox || 0);
            playerTotals[player] = total;
            if (total > maxTotal) maxTotal = total;
        });
        const maxTotalPlayers = activePlayers.filter(p => playerTotals[p] === maxTotal);
        const shouldHighlightTotal = maxTotalPlayers.length === 1 && maxTotal > 0;

        html += '<tr>';
        html += '<td class="dice-cell" style="font-weight:bold;font-size:13px">合计</td>';
        activePlayers.forEach(player => {
            const total = playerTotals[player];
            const highlightClass = shouldHighlightTotal && total === maxTotal ? ' highlight' : '';
            html += `<td class="player-cell player-${player}${highlightClass}">
                <span class="count">${total}</span>
            </td>`;
        });
        html += '</tr>';

        html += '</tbody></table>';

        html += '</div>';
        return html;
    }

    /**
     * 检查模态框是否可见
     */
    isVisible() {
        return this.modal && this.modal.classList.contains('show');
    }

    /**
     * 生成排名数据
     * @param {number} winnerPlayer - 获胜玩家编号
     * @returns {Array} 排名数据数组
     */
    generateRankingsData(winnerPlayer) {
        const rankings = [];

        // 只处理激活的玩家，避免显示未参与游戏的玩家
        const activePlayers = activePlayerManager.getActivePlayers();

        activePlayers.forEach(player => {
            const progress = this.getPlayerProgress(player);
            const defeatCounts = this.getPlayerDefeatCounts(player);
            rankings.push({
                player: player,
                progress: progress,
                defeatCounts: defeatCounts,
                isWinner: player === winnerPlayer
            });
        });
        // 按完成度排序（获胜者优先，然后按进度排序）
        rankings.sort((a, b) => {
            if (a.isWinner && !b.isWinner) return -1;
            if (!a.isWinner && b.isWinner) return 1;
            return b.progress - a.progress;
        });

        // 为排序后的排名添加 position 字段，用于称号计算
        rankings.forEach((r, i) => r.position = i + 1);

        // 计算并添加称号
        const playerTitles = titleManager.calculateTitles(this.gameState, rankings);
        rankings.forEach(r => {
            r.title = playerTitles[r.player];
        });

        console.log(`[结算模态框] 排序后的排名数据:`, rankings);

        return rankings;
    }

    /**
     * 获取玩家完成度（直接从progressDisplay获取）
     * @param {number} player - 玩家编号
     * @returns {number} 完成度百分比
     */
    getPlayerProgress(player) {

        if (!this.progressDisplay || !this.gameState) {
            return 0;
        }

        // 直接使用progressDisplay的计算方法
        const progress = this.progressDisplay.calculatePlayerProgress(player, this.gameState);

        return progress;
    }

    /**
     * 获取玩家的defeat统计
     * @param {number} player - 玩家编号
     * @returns {Object} defeat统计对象
     */
    getPlayerDefeatCounts(player) {
        if (!this.defeatCountDisplay) return {};

        const defeatCounts = {};
        for (let opponent = 1; opponent <= 4; opponent++) {
            if (opponent !== player) {
                defeatCounts[opponent] = this.gameState.getDefeatCount(player, opponent);
            }
        }

        return defeatCounts;
    }

    /**
     * 渲染排名列表
     * @param {Array} rankingsData - 排名数据
     */
    renderRankings(rankingsData) {
        if (!this.rankingsContainer) return;

        // 清除旧的轮播定时器
        if (this._carouselTimer) {
            clearInterval(this._carouselTimer);
            this._carouselTimer = null;
        }
        this._carouselItems = [];

        this.rankingsContainer.innerHTML = '';

        rankingsData.forEach((data, index) => {
            const rankingItem = this.createRankingItem(data, index + 1);
            this.rankingsContainer.appendChild(rankingItem);
        });

        // 所有卡片创建完后，启动共享轮播
        if (this._carouselItems.length > 0) {
            const playerCount = rankingsData.length;
            // 等待所有卡片翻转完成后启动（最晚一张翻转 + 缓冲）
            const flipEnd = 600 + (playerCount - 1) * 400 + 300;
            setTimeout(() => {
                this._carouselTimer = setInterval(() => {
                    // 所有卡片同时淡出
                    this._carouselItems.forEach(item => {
                        item.titleContent.style.opacity = '0';
                    });
                    setTimeout(() => {
                        this._carouselItems.forEach(item => {
                            item.index = (item.index + 1) % item.titles.length;
                            item.titleBadge.textContent = item.titles[item.index]?.name || '平凡棋手';
                            item.titleDesc.textContent = item.titles[item.index]?.desc || '';
                            item.ribbon.textContent = `${item.index + 1}/${item.titles.length}`;
                            item.titleContent.style.opacity = '1';
                        });
                    }, 200);
                }, 2500);
            }, flipEnd);
        }
    }

    /**
     * 创建排名项元素
     * @param {Object} data - 玩家数据
     * @param {number} position - 排名位置
     * @returns {HTMLElement} 排名项元素
     */
    createRankingItem(data, position) {
        const item = document.createElement('div');
        // 初始化时默认显示反面 (添加 is-flipped)
        item.className = 'ranking-item flip-card is-flipped';

        // 卡片内层容器
        const cardInner = document.createElement('div');
        cardInner.className = 'flip-card-inner';

        // --- 正面 ---
        const cardFront = document.createElement('div');
        cardFront.className = 'flip-card-front';

        // 排名位置
        const positionEl = document.createElement('div');
        positionEl.className = `ranking-position ${this.getPositionClass(position)}`;
        positionEl.textContent = position;

        // 玩家头像
        const avatar = document.createElement('div');
        avatar.className = `player-avatar player-${data.player}-avatar ranking-avatar`;
        const emoji = document.createElement('div');
        emoji.className = 'player-emoji';
        const gameEmoji = document.querySelector(`#player-${data.player}-emoji`);
        if (gameEmoji) {
            emoji.innerHTML = gameEmoji.innerHTML;
        }
        avatar.appendChild(emoji);

        // 玩家信息
        const info = document.createElement('div');
        info.className = 'ranking-info';
        const name = document.createElement('div');
        name.className = `ranking-name player-${data.player}-name`;
        let playerName = `Player ${data.player}`;
        if (playerNameManager) {
            playerName = getDisplayName(data.player);
        }
        name.textContent = playerName;
        const progress = document.createElement('div');
        progress.className = 'ranking-progress';
        progress.textContent = `完成度: ${data.progress}%`;
        info.appendChild(name);
        info.appendChild(progress);

        // Defeat统计
        const defeats = document.createElement('div');
        defeats.className = 'ranking-defeats';
        for (let opponent = 1; opponent <= 4; opponent++) {
            if (opponent !== data.player) {
                const count = document.createElement('span');
                count.className = `defeat-count player-${opponent}-defeat`;
                count.textContent = data.defeatCounts[opponent] || 0;
                defeats.appendChild(count);
            }
        }

        cardFront.appendChild(positionEl);
        cardFront.appendChild(avatar);
        cardFront.appendChild(info);
        cardFront.appendChild(defeats);

        // --- 反面 ---
        const cardBack = document.createElement('div');
        cardBack.className = `flip-card-back player-${data.player}-stats-bg`;

        // 处理称号数组（向后兼容：单个对象也转为数组）
        const titles = Array.isArray(data.title) ? data.title : [data.title];
        const titleContent = document.createElement('div');
        titleContent.className = 'ranking-title-content';
        titleContent.style.opacity = '1';

        const titleBadge = document.createElement('div');
        titleBadge.className = `ranking-title-badge player-${data.player}-name`;
        titleBadge.textContent = titles[0]?.name || '平凡棋手';

        const titleDesc = document.createElement('div');
        titleDesc.className = 'ranking-title-desc';
        titleDesc.textContent = titles[0]?.desc || '平平淡淡才是真';

        titleContent.appendChild(titleBadge);
        titleContent.appendChild(titleDesc);
        cardBack.appendChild(titleContent);

        // 右下角斜角计数带（仅多称号时显示）
        let ribbon = null;
        if (titles.length > 1) {
            ribbon = document.createElement('div');
            ribbon.className = `title-counter-ribbon player-${data.player}-ribbon`;
            ribbon.textContent = `1/${titles.length}`;
            cardBack.appendChild(ribbon);
        }

        // 组装卡片
        cardInner.appendChild(cardFront);
        cardInner.appendChild(cardBack);
        item.appendChild(cardInner);

        // 绑定点击翻转事件
        item.addEventListener('click', () => {
            item.classList.toggle('is-flipped');
        });

        // 设置称号轮播：翻转动画后开始循环切换所有称号
        if (titles.length > 1) {
            const carouselData = { titleContent, titleBadge, titleDesc, ribbon, titles, index: 0 };
            if (!this._carouselItems) this._carouselItems = [];
            this._carouselItems.push(carouselData);
        }

        return item;
    }

    /**
     * 获取排名位置的CSS类名
     * @param {number} position - 排名位置
     * @returns {string} CSS类名
     */
    getPositionClass(position) {
        switch (position) {
            case 1: return 'first';
            case 2: return 'second';
            case 3: return 'third';
            default: return '';
        }
    }

    /**
     * 更新时间戳和游戏用时显示
     */
    updateTimestamp() {
        const timestampElement = document.getElementById('settlement-timestamp');
        const durationElement = document.getElementById('settlement-duration');

        if (timestampElement) {
            // 显示完成时间
            const now = new Date();
            const timeString = now.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            timestampElement.textContent = `${timeString}`;
        }

        if (durationElement && this.gameState) {
            // 显示游戏用时
            const gameDuration = this.gameState.getFormattedGameDuration();
            durationElement.textContent = `${gameDuration}`;
        }
    }

    /**
     * 更新结算弹框的模式标记
     */
    _updateModeLabel() {
        const modeEl = document.getElementById('settlement-mode');
        if (!modeEl) return;
        modeEl.textContent = '';
        if (!this.gameState) return;
        const isHappy = this.gameState.isHappyMode();
        const isSkill = window.energyManager?.isSkillModeEnabled();
        if (isHappy && isSkill) {
            modeEl.textContent = '道具欢乐';
        } else if (isHappy) {
            modeEl.textContent = '欢乐模式';
        } else if (isSkill) {
            modeEl.textContent = '道具模式';
        } else {
            modeEl.textContent = '经典模式';
        }
    }

    /**
     * 返回房间
     */
    returnToRoom() {
        // 清理历史数据，释放内存
        if (this.gameState && typeof this.gameState.clearProgressHistory === 'function') {
            this.gameState.clearProgressHistory();
        }

        // 检查是否在联机模式
        const isOnlineMode = window.gameInstance &&
            window.gameInstance.multiplayerGameManager &&
            window.gameInstance.multiplayerGameManager.isOnlineMode;

        if (isOnlineMode) {
            console.log('[结算] 联机模式 - 返回房间');

            const multiplayerGameManager = window.gameInstance.multiplayerGameManager;

            if (multiplayerGameManager) {
                multiplayerGameManager.disableReconnect = true;
                multiplayerGameManager.gameSessionId = null;
            }

            let roomCode = reconnectManager.roomCode;
            if (!roomCode) {
                try {
                    const url = new URL(window.location.href);
                    roomCode = url.searchParams.get('room');
                } catch (error) {
                    // ignore
                }
            }

            if (roomCode) {
                sessionStorage.setItem('aeroplaneChess_resetReadyOnRoomReturn', 'true');
                reconnectManager.updateGameSessionId(null);
                reconnectManager.updateRoomCode(roomCode);
            }

            // 发送离开房间消息并断开连接
            try {
                if (multiplayerGameManager && typeof multiplayerGameManager.sendMessage === 'function') {
                    multiplayerGameManager.sendMessage('returnToRoom');
                }
            } catch (error) {
                console.error('[结算] 发送returnToRoom失败:', error);
            }

            if (multiplayerGameManager && typeof multiplayerGameManager.destroy === 'function') {
                try {
                    setTimeout(() => {
                        try {
                            multiplayerGameManager.destroy();
                            console.log('[结算] WebSocket连接已断开');
                        } catch (error) {
                            console.error('[结算] 断开连接失败:', error);
                        }
                    }, 80);
                } catch (error) {
                    console.error('[结算] 断开连接失败:', error);
                }
            }
        }

        this.hide();

        setTimeout(() => {
            let roomCode = reconnectManager.roomCode;
            if (!roomCode) {
                try {
                    const url = new URL(window.location.href);
                    roomCode = url.searchParams.get('room');
                } catch (error) {
                    // ignore
                }
            }

            if (roomCode) {
                window.location.replace(`/?room=${roomCode}`);
            } else {
                // 根据当前游戏模式设置 sessionStorage 标志，以便在主页自动恢复对应面板
                if (this.gameState && this.gameState.gameMode) {
                    if (this.gameState.gameMode === 'ai_battle') {
                        sessionStorage.setItem('lastGameMode', 'ai');
                    } else if (this.gameState.gameMode === 'local_multiplayer') {
                        sessionStorage.setItem('lastGameMode', 'local');
                    }
                }
                window.location.replace('/');
            }
        }, 50);
    }
}

export default SettlementModal;
