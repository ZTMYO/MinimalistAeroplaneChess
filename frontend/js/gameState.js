import { activePlayerManager } from './activePlayerManager.js';

class GameState {
    constructor() {
        // 思考时间常量（毫秒）
        this.THINKING_TIME = 20000; // 20秒思考时间

        // 游戏基础状态
        this.currentPlayer = null; // 当前玩家 (1-4)，初始设为null以确保首次设置时触发日志
        this.gamePhase = 'rolling'; // 游戏阶段: waiting, rolling, selecting, moving, finished
        this.diceValue = 0; // 骰子点数
        this.selectedChess = null; // 选中的棋子
        this.winner = null; // 获胜者
        this.isRolling = false; // 防抖标志，防止重复点击骰子
        this.consecutiveSixes = 0; // 当前回合连续摇到6的次数
        this.canReroll = false; // 是否可以重新投骰
        this.isRemoteDice = false; // 标记是否是遥控骰子（6点不触发连投）
        this.isPaused = false; // 游戏暂停状态
        this.isAITakeover = false; // AI托管状态
        this.aiDecisionInProgress = false; // AI决策进行中状态
        this.chessMoving = false; // 棋子移动中状态
        this.gamePhaseBeforePause = null; // 暂停前的游戏阶段
        this.currentPlayerBeforePause = null; // 暂停前的当前玩家
        this.gameOfficiallyStarted = false; // 游戏是否正式开始（人类玩家进行了首次操作）
        this.isLocalMultiplayer = false; // 是否为本地多人模式
        this.isOnlineMultiplayer = false; // 是否为在线多人模式
        this.isInChessAnimation = false; // 是否在棋子动画中（防止bringToFront破坏动画）
        this.isThreeSixesPenaltyActive = false; // 三次6惩罚是否正在执行中
        this.happyMode = false; // 欢乐模式标志

        // 棋子数量配置
        this.pieceCount = 4; // 默认每个玩家4个棋子

        // 电脑玩家配置
        this.botPlayers = new Set(); // 存储电脑玩家编号的集合

        // 思考时间相关状态
        this.thinkingTimer = null; // 思考时间计时器
        this.thinkingStartTime = null; // 思考开始时间
        this.thinkingTimeRemaining = 0; // 剩余思考时间
        this.pausedThinkingTime = 0; // 暂停期间累计的时间
        this.pauseStartTime = null; // 暂停开始时间
        this.thinkingTimerOwner = null; // 当前计时器所属玩家（进度条颜色依据）
        this.thinkingProgressDisplayOwner = null; // 动画期间锁定的进度条展示归属（本次掷骰者）

        // 由 shared/engine.mjs 接管规则的标志（单机模式开启）
        this.engineDriven = false;

        // 主轨道位置
        this.mainTrack = this.generateMainTrack();
        this.trackRotations = this.calculateTrackRotations(this.mainTrack);

        // 玩家起始区域位置 - 所有玩家使用相同的基础坐标，通过旋转区分
        // 坐标已减去偏移量(-5.6)以确保棋子正确显示
        this.startPositions = {
            1: [
                { x: -73.9, y: 66.1 }, { x: -62.2, y: 66.1 },
                { x: -73.9, y: 77.9 }, { x: -62.2, y: 77.9 }
            ],
            2: [
                { x: -73.9, y: 66.1 }, { x: -62.2, y: 66.1 },
                { x: -73.9, y: 77.9 }, { x: -62.2, y: 77.9 }
            ],
            3: [
                { x: -73.9, y: 66.1 }, { x: -62.2, y: 66.1 },
                { x: -73.9, y: 77.9 }, { x: -62.2, y: 77.9 }
            ],
            4: [
                { x: -73.9, y: 66.1 }, { x: -62.2, y: 66.1 },
                { x: -73.9, y: 77.9 }, { x: -62.2, y: 77.9 }
            ]
        };

        // 初始化玩家棋子状态（默认4个棋子）
        this.initializePlayerChess(4);

        // 击败次数统计
        this.defeatCounts = {
            1: { 2: 0, 3: 0, 4: 0 }, // 玩家1击败其他玩家的次数
            2: { 1: 0, 3: 0, 4: 0 }, // 玩家2击败其他玩家的次数
            3: { 1: 0, 2: 0, 4: 0 }, // 玩家3击败其他玩家的次数
            4: { 1: 0, 2: 0, 3: 0 }  // 玩家4击败其他玩家的次数
        };

        // 游戏时间记录
        this.gameStartTime = null; // 游戏开始时间
        this.gameEndTime = null;   // 游戏结束时间

        // 骰子投掷统计（用于数据分析）
        this.diceStatistics = {
            1: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, // 玩家1的投掷统计
            2: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, // 玩家2的投掷统计
            3: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }, // 玩家3的投掷统计
            4: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }  // 玩家4的投掷统计
        };

        // 总前进距离统计
        this.totalDistance = {
            1: 0,
            2: 0,
            3: 0,
            4: 0
        };

        // 完成度历史记录（用于绘制折线图）
        this.progressHistory = [];
        this.currentRound = 0; // 当前回合数
        this.MAX_PROGRESS_HISTORY = 500; // 最大保存500个快照，防止内存溢出

        // 称号相关统计数据
        this.titleStats = {
            consecutiveOnes: { 1: 0, 2: 0, 3: 0, 4: 0 },    // 连续摇到1的次数
            consecutiveNoTakeoff: { 1: 0, 2: 0, 3: 0, 4: 0 }, // 连续无法起飞的次数
            maxConsecutiveSixes: { 1: 0, 2: 0, 3: 0, 4: 0 }, // 最大连续摇到6的次数
            firstFinishedPlayer: null,                       // 首个有棋子到达终点的玩家
            bounceSteps: { 1: 0, 2: 0, 3: 0, 4: 0 },         // 累计反弹格数（终点反弹+叠子反弹）
            maxTeleportDistance: { 1: 0, 2: 0, 3: 0, 4: 0 }, // 单次传送最大距离
            mysteryBoxMax: { 1: 0, 2: 0, 3: 0, 4: 0 },       // 盲盒开出最高积分
            mysteryBoxMin: { 1: 99, 2: 99, 3: 99, 4: 99 },    // 盲盒开出最低积分（初始99确保0被记录）
            polyhedralMax: { 1: 0, 2: 0, 3: 0, 4: 0 },        // 多面骰子最大点数
            polyhedralMin: { 1: 99, 2: 99, 3: 99, 4: 99 },     // 多面骰子最小点数（初始99确保1被记录）
            skillUseCount: { 1: 0, 2: 0, 3: 0, 4: 0 }          // 累计使用道具次数
        };

        // 道具统计数据（用于结算面板显示）
        this.totalEnergyGained = { 1: 0, 2: 0, 3: 0, 4: 0 };   // 累计获取的有效积分（扣除溢出）
        this.skillUsage = {                                       // 各道具使用次数明细
            1: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            2: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            3: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            4: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 }
        };
    }

    // 初始化玩家棋子状态
    initializePlayerChess(pieceCount) {
        this.pieceCount = pieceCount;
        this.playerChess = {};

        for (let player = 1; player <= 4; player++) {
            this.playerChess[player] = [];
            for (let i = 0; i < pieceCount; i++) {
                this.playerChess[player].push({
                    position: -1, // position: -1表示在起始区域
                    element: null,
                    finished: false,
                    lastLandPos: -1 // 初始化最后落位位置标识
                });
            }
        }
    }

    generateMainTrack() {
        // 主轨道位置数组，包含所有移动路径
        const track = [];

        // 位置0-50：外圈轨道
        track.push({ x: -45, y: 82 });    // 0 - 所有棋子的起点
        track.push({ x: -35, y: 78 });    // 1
        track.push({ x: -38.5, y: 66 });  // 2
        track.push({ x: -38.5, y: 53.5 });// 3
        track.push({ x: -33.5, y: 41.5 });// 4
        track.push({ x: -41.5, y: 33.5 });// 5
        track.push({ x: -53, y: 38 });    // 6
        track.push({ x: -65.5, y: 38 });  // 7
        track.push({ x: -78.5, y: 34.5 });// 8
        track.push({ x: -80, y: 24 });    // 9
        track.push({ x: -80, y: 12 });    // 10
        track.push({ x: -80, y: 0 });     // 11
        track.push({ x: -80, y: -12 });   // 12
        track.push({ x: -80, y: -24 });   // 13
        track.push({ x: -78.5, y: -34.5 });// 14
        track.push({ x: -65.5, y: -38 }); // 15
        track.push({ x: -53, y: -38 });   // 16 
        track.push({ x: -41.5, y: -33.5 });// 17
        track.push({ x: -33.5, y: -41.5 });// 18
        track.push({ x: -38.5, y: -53.5 }); // 19
        track.push({ x: -38.5, y: -66 });   // 20
        track.push({ x: -34.5, y: -78.5 }); // 21
        track.push({ x: -24, y: -80 });     // 22
        track.push({ x: -12, y: -80 });     // 23
        track.push({ x: 0, y: -80 });       // 24
        track.push({ x: 12, y: -80 });      // 25
        track.push({ x: 24, y: -80 });      // 26
        track.push({ x: 34.5, y: -78.5 });  // 27
        track.push({ x: 38.5, y: -66 });    // 28
        track.push({ x: 38.5, y: -53.5 });  // 29
        track.push({ x: 33.5, y: -41.5 });  // 30
        track.push({ x: 41.5, y: -33.5 });  // 31
        track.push({ x: 53, y: -38 });      // 32
        track.push({ x: 65.5, y: -38 });    // 33
        track.push({ x: 78.5, y: -34.5 });  // 34
        track.push({ x: 80, y: -24 });      // 35
        track.push({ x: 80, y: -12 });      // 36
        track.push({ x: 80, y: 0 });        // 37
        track.push({ x: 80, y: 12 });       // 38
        track.push({ x: 80, y: 24 });       // 39
        track.push({ x: 78.5, y: 34.5 });   // 40
        track.push({ x: 65.5, y: 38 });     // 41
        track.push({ x: 53, y: 38 });       // 42 
        track.push({ x: 41.5, y: 33.5 });   // 43
        track.push({ x: 33.5, y: 41.5 });   // 44
        track.push({ x: 38.5, y: 53.5 });   // 45
        track.push({ x: 38.5, y: 66 });     // 46
        track.push({ x: 34.5, y: 78.5 });   // 47
        track.push({ x: 24, y: 80 });       // 48
        track.push({ x: 12, y: 80 });       // 49
        track.push({ x: 0, y: 80 });        // 50

        // 位置51-56：中央终点通道
        track.push({ x: 0, y: 66 });    // 51
        track.push({ x: 0, y: 54 });    // 52
        track.push({ x: 0, y: 42 });    // 53
        track.push({ x: 0, y: 30 });    // 54
        track.push({ x: 0, y: 18 });    // 55
        track.push({ x: 0, y: 7 });     // 56 - 终点

        return track;
    }

    // 计算轨道每一段的旋转角度（基于轴向变化，确保直道不歪斜）
    calculateTrackRotations(track) {
        const rotations = [];
        let currentRotation = -90; // 初始朝向向上（玩家1基准）

        for (let i = 0; i < track.length; i++) {
            if (i > 0) {
                const p1 = track[i-1];
                const p2 = track[i];
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;

                // 只有当移动距离超过一定阈值时才判断转向（过滤微小偏移）
                if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
                    let targetAngle = currentRotation;
                    
                    if (Math.abs(dx) > Math.abs(dy)) {
                        targetAngle = dx > 0 ? 0 : 180; // 水平移动
                    } else {
                        targetAngle = dy > 0 ? 90 : -90; // 垂直移动
                    }

                    // 处理角度累积，确保旋转方向最短
                    let diff = targetAngle - (currentRotation % 360);
                    while (diff > 180) diff -= 360;
                    while (diff < -180) diff += 360;
                    
                    currentRotation += diff;
                }
            }
            rotations.push(currentRotation);
        }
        return rotations;
    }

    // 设置指定状态
    setState(key, value) {
        this[key] = value;
    }

    // 获取指定玩家的指定棋子状态
    getChessState(player, index) {
        return this.playerChess[player][index];
    }

    // 更新棋子位置
    updateChessPosition(player, index, position) {
        this.playerChess[player][index].position = position;
    }


    // 重置游戏状态
    resetGameState() {
        // 清除思考时间计时器与窗口（新一局重新开始计时）
        this.clearThinkingWindow();

        this.currentPlayer = null;
        this.gamePhase = 'waiting';
        this.diceValue = 0;
        this.selectedChess = null;
        this.winner = null;
        this.isRolling = false;
        this.consecutiveSixes = 0;
        this.canReroll = false;
        this.isRemoteDice = false;
        this.gameOfficiallyStarted = false; // 重置游戏正式开始状态
        this.isLocalMultiplayer = false; // 重置本地多人模式状态
        this.isOnlineMultiplayer = false; // 重置在线多人模式状态

        // 重置暂停状态
        this.isPaused = false;
        this.gamePhaseBeforePause = null;
        this.currentPlayerBeforePause = null;
        this.pausedThinkingTime = 0;
        this.pauseStartTime = null;

        // 重置所有棋子状态
        for (let player = 1; player <= 4; player++) {
            for (let i = 0; i < this.pieceCount; i++) {
                this.playerChess[player][i].position = -1;
                this.playerChess[player][i].finished = false;
                // 保留element引用，不重置
            }
        }

        // 重置积分系统（仅在道具模式启用时）
        if (window.energyManager && window.energyManager.isSkillModeEnabled()) {
            window.energyManager.resetAllEnergy();
            console.log('[游戏状态] 已重置所有玩家积分');
        }

        // 重置击败次数统计
        for (let player = 1; player <= 4; player++) {
            for (let opponent = 1; opponent <= 4; opponent++) {
                if (player !== opponent) {
                    this.defeatCounts[player][opponent] = 0;
                }
            }
        }

        // 重置游戏时间记录
        this.gameStartTime = null;
        this.gameEndTime = null;

        // 重置总前进距离统计
        for (let player = 1; player <= 4; player++) {
            this.totalDistance[player] = 0;
        }

        // 重置称号统计
        this.titleStats = {
            consecutiveOnes: { 1: 0, 2: 0, 3: 0, 4: 0 },
            consecutiveNoTakeoff: { 1: 0, 2: 0, 3: 0, 4: 0 },
            maxConsecutiveSixes: { 1: 0, 2: 0, 3: 0, 4: 0 },
            firstFinishedPlayer: null,
            bounceSteps: { 1: 0, 2: 0, 3: 0, 4: 0 },
            maxTeleportDistance: { 1: 0, 2: 0, 3: 0, 4: 0 },
            mysteryBoxMax: { 1: 0, 2: 0, 3: 0, 4: 0 },
            mysteryBoxMin: { 1: 99, 2: 99, 3: 99, 4: 99 },
            polyhedralMax: { 1: 0, 2: 0, 3: 0, 4: 0 },
            polyhedralMin: { 1: 99, 2: 99, 3: 99, 4: 99 },
            skillUseCount: { 1: 0, 2: 0, 3: 0, 4: 0 }
        };

        // 重置道具统计数据
        this.totalEnergyGained = { 1: 0, 2: 0, 3: 0, 4: 0 };
        this.skillUsage = {
            1: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            2: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            3: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 },
            4: { remoteDice: 0, teleport: 0, polyhedralDice: 0, mysteryBox: 0 }
        };
    }



    // 获取玩家总前进距离
    getTotalDistance(player) {
        return this.totalDistance[player] || 0;
    }

    // 记录骰子投掷（用于称号统计）
    recordDiceRollForTitle(player, value, isRemoteDice = false) {
        if (isRemoteDice) return;

        // 1. 连续1点统计
        if (value === 1) {
            this.titleStats.consecutiveOnes[player]++;
        } else {
            this.titleStats.consecutiveOnes[player] = 0;
        }

        // 2. 最大连续6点统计
        // 注意：consecutiveSixes 会在 Dice.js 或 server 同步中更新
        // 我们在这里记录它达到的历史最大值
        if (this.consecutiveSixes > this.titleStats.maxConsecutiveSixes[player]) {
            this.titleStats.maxConsecutiveSixes[player] = this.consecutiveSixes;
        }
    }

    // 记录起飞尝试结果（用于称号统计）
    recordTakeoffAttempt(player, success) {
        if (success) {
            this.titleStats.consecutiveNoTakeoff[player] = 0;
        } else {
            // 只有当玩家确实有棋子在基地且无法起飞时才累加
            const hasChessInBase = this.playerChess[player].some(c => c.position === -1);
            const hasChessOnTrack = this.playerChess[player].some(c => c.position >= 0 && !c.finished);
            
            if (hasChessInBase && !hasChessOnTrack) {
                this.titleStats.consecutiveNoTakeoff[player]++;
            } else {
                // 如果已经在轨道上有棋子了，不算作“无法起飞”
                this.titleStats.consecutiveNoTakeoff[player] = 0;
            }
        }
    }

    // 记录反弹格数（用于称号统计）
    recordBounceSteps(player, steps) {
        if (this.titleStats.bounceSteps && this.titleStats.bounceSteps[player] !== undefined) {
            this.titleStats.bounceSteps[player] += Math.max(0, steps);
        }
    }

    // 检查玩家是否只剩一颗未完成的棋子
    hasOnlyOneUnfinishedChess(player) {
        let unfinishedCount = 0;
        for (let i = 0; i < this.pieceCount; i++) {
            if (!this.playerChess[player][i].finished) {
                unfinishedCount++;
                if (unfinishedCount > 1) {
                    return false;
                }
            }
        }
        return unfinishedCount === 1;
    }

    // 切换到下一个玩家
    nextPlayer(uiUpdater = null, handleThinkingTimeoutWrapper = null, triggerBotOperationIfNeeded = null) {
        // 引擎已经推进过回合，这里只把 activePlayerManager 对齐到引擎的当前玩家
        const nextPlayer = this.currentPlayer;
        activePlayerManager.setCurrentActivePlayer(nextPlayer);

        // 保存当前回合的完成度快照（在切换玩家之前）
        this.saveProgressSnapshot();

        // 增加回合计数（当回到玩家1时，表示一轮结束）
        if (nextPlayer === 1 || this.currentPlayer === activePlayerManager.getActivePlayers()[activePlayerManager.getActivePlayers().length - 1]) {
            this.currentRound++;
        }

        this.setCurrentPlayer(nextPlayer);

        // 清除传送门模式和遥控骰子特效（如果存在）
        if (window.gameInstance) {
            window.gameInstance.isTeleportMode = false;
            // 恢复骰子显示
            if (window.gameInstance.skillManager) {
                window.gameInstance.skillManager.restoreDiceIcon();
            }
        }

        // 清除遥控骰子特效
        const diceDisplay = document.getElementById('diceDisplay');
        if (diceDisplay) {
            diceDisplay.classList.remove('remote-dice');
        }

        // 重置游戏状态
        this.gamePhase = 'rolling';
        this.diceValue = 0;
        this.selectedChess = null;
        this.consecutiveSixes = 0;
        this.canReroll = false;
        this.isRemoteDice = false;
        this.isThreeSixesPenaltyActive = false; // 确保清除三次6惩罚标志

        // 在线多人模式下停止当前进度条；回合推进由服务端权威棋面驱动，无需本地广播
        if (this.isOnlineMultiplayer && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            if (uiUpdater && uiUpdater.stopThinkingProgressBar) {
                uiUpdater.stopThinkingProgressBar();
            }
        }

        // 更新UI（如果提供了uiUpdater）
        if (uiUpdater && uiUpdater.updateUI) {
            uiUpdater.updateUI();
        }

        // 更新积分面板显示（在本地多人和人机模式下）
        if (window.gameInstance && window.gameInstance.skillManager && window.gameInstance.energyManager) {
            if (window.gameInstance.energyManager.isSkillModeEnabled()) {
                window.gameInstance.skillManager.updateEnergyDisplay();
                window.gameInstance.skillManager.updateSkillAvailability();
            }
        }

        // 如果游戏已暂停，不启动思考时间计时器，也不触发bot操作
        if (this.getIsPaused()) {
            console.log('游戏已暂停，已切换玩家，但不启动计时器和AI操作');
            return;
        }

        // 启动新玩家的思考时间计时器（掷骰子阶段）
        // 只有在线多人模式需要处理思考超时（通过网络同步触发）
        // 单机模式（人机/本地多人）不需要思考时间倒计时
        if (this.isOnlineMultiplayer && uiUpdater && uiUpdater.startThinkingProgressBar && handleThinkingTimeoutWrapper) {
            uiUpdater.startThinkingProgressBar(() => {
                console.log(`玩家${this.currentPlayer}掷骰子思考时间到，自动切换到下一个玩家`);
                handleThinkingTimeoutWrapper();
            });
        }

        // 检查新玩家是否为bot，如果是则触发bot操作
        if (triggerBotOperationIfNeeded) {
            triggerBotOperationIfNeeded();
        }
    }

    // 获取当前玩家
    getCurrentPlayer() {
        return this.currentPlayer;
    }

    // 设置当前玩家
    setCurrentPlayer(player) {
        if (this.currentPlayer === player) return;
        this.currentPlayer = player;
    }

    // 获取游戏阶段
    getGamePhase() {
        return this.gamePhase;
    }

    // 设置游戏阶段
    setGamePhase(phase) {
        const oldPhase = this.gamePhase;
        this.gamePhase = phase;

        // 当游戏阶段切换到rolling或selecting时，检查是否需要触发AI操作
        // 注意：联机模式下，AI操作由 handlePlayerTurnChange 统一处理，这里不触发
        if ((phase === 'rolling' || phase === 'selecting') && oldPhase !== phase) {
            // 联机模式下跳过，避免重复触发
            if (this.isOnlineMultiplayer) {
                return;
            }

            // 延迟触发，确保阶段切换完成（仅单机模式）
            setTimeout(() => {
                // 检查当前玩家是否为bot或处于AI托管状态
                const currentPlayer = this.getCurrentPlayer();
                const isBotPlayer = this.isBotPlayer(currentPlayer);
                const isAITakeover = this.getIsAITakeover();

                if (isBotPlayer || isAITakeover) {
                    // 触发AI操作
                    if (window.eventHandler && window.eventHandler.triggerBotOperationIfNeeded) {
                        window.eventHandler.triggerBotOperationIfNeeded();
                    }
                }
            }, 100);
        }
    }

    // 获取骰子值
    getDiceValue() {
        return this.diceValue;
    }

    // 设置骰子值
    setDiceValue(value) {
        this.diceValue = value;
    }

    getGameOfficiallyStarted() {
        return this.gameOfficiallyStarted;
    }

    // 设置游戏是否正式开始
    setGameOfficiallyStarted(started) {
        this.gameOfficiallyStarted = started;
    }

    // 获取是否为本地多人模式
    getIsLocalMultiplayer() {
        return this.isLocalMultiplayer;
    }

    // 设置本地多人模式状态
    setIsLocalMultiplayer(isLocal) {
        this.isLocalMultiplayer = isLocal;
    }

    // 获取是否为在线多人模式
    getIsOnlineMultiplayer() {
        return this.isOnlineMultiplayer;
    }

    // 设置在线多人模式状态
    setIsOnlineMultiplayer(isOnline) {
        this.isOnlineMultiplayer = isOnline;
    }

    // 获取是否正在掷骰子
    getIsRolling() {
        return this.isRolling;
    }


    // 获取选中的棋子
    getSelectedChess() {
        return this.selectedChess;
    }

    // 设置选中的棋子
    setSelectedChess(chess) {
        this.selectedChess = chess;
    }

    // 获取欢乐模式状态
    isHappyMode() {
        return this.happyMode;
    }

    // 设置欢乐模式状态
    setHappyMode(enabled) {
        this.happyMode = enabled === true;
    }

    // 获取玩家棋子数据
    getPlayerChess() {
        return this.playerChess;
    }

    // 获取连续6的次数
    getConsecutiveSixes() {
        return this.consecutiveSixes;
    }

    // 设置连续6的次数
    setConsecutiveSixes(count) {
        this.consecutiveSixes = count;
    }

    // 获取是否可以重新掷骰
    getCanReroll() {
        return this.canReroll;
    }

    // 设置是否可以重新掷骰
    setCanReroll(canReroll) {
        this.canReroll = canReroll;
    }

    // 获取获胜者
    getWinner() {
        return this.winner;
    }

    /**
     * 本局是否开启道具模式。
     * 本地模式（单机 / 本地多人）由开局配置决定，引擎要用同一个值建初始状态；
     * 联机由服务端下发，不看这里。首次读取后缓存，换模式会整页重载。
     */
    isSkillModeEnabled() {
        if (this._skillModeEnabled === undefined) {
            try {
                const raw = sessionStorage.getItem('gameConfig');
                this._skillModeEnabled = Boolean(raw && JSON.parse(raw).skillMode === true);
            } catch (error) {
                this._skillModeEnabled = false;
            }
        }
        return this._skillModeEnabled;
    }


    // 重置游戏
    async resetGame() {
        // 重置AI托管状态
        const { aiTakeoverManager } = await import('./aiTakeoverManager.js');
        aiTakeoverManager.reset();

        this.resetGameState();
    }

    // 思考时间相关方法

    // 开始思考时间计时
    startThinkingTimer(onTimeout) {
        // 暂停期间不启动计时器，跑完会触发超时接管
        if (this.isPaused) {
            return;
        }
        // 这一回合的窗口还没走完就接着走：窗口起点由服务端维护，
        // 刷新、重连、补快照都只是重发同一扇窗，不该换来新的思考时间
        if (this.getRemainingThinkingTime() > 0) {
            this.resumeThinkingTimer(onTimeout);
            return;
        }
        this.clearThinkingTimer();
        const startTime = Date.now();
        const playerAtStart = this.currentPlayer;
        const phaseAtStart = this.gamePhase;

        this.thinkingStartTime = startTime;
        this.thinkingTimeRemaining = this.THINKING_TIME;
        this.pausedThinkingTime = 0; // 暂停期间累计的时间
        // 进度条颜色锁定到本次计时所属玩家
        this.thinkingTimerOwner = playerAtStart;

        // 记录本次计时上下文，避免回合切换/重连导致“旧计时器”误触发
        this._thinkingTimerContext = {
            startTime,
            player: playerAtStart,
            phase: phaseAtStart
        };

        this.thinkingTimer = setTimeout(() => {
            // 只有当玩家/阶段/起始时间都与启动时一致，才允许触发超时
            // 否则说明期间已经切换回合或重启计时，应忽略该超时
            if (!this._thinkingTimerContext ||
                this._thinkingTimerContext.startTime !== startTime ||
                this.currentPlayer !== playerAtStart ||
                this.gamePhase !== phaseAtStart) {
                console.log('[思考计时] 忽略过期的超时回调', {
                    expectedPlayer: playerAtStart,
                    currentPlayer: this.currentPlayer,
                    expectedPhase: phaseAtStart,
                    currentPhase: this.gamePhase
                });
                return;
            }
            this.clearThinkingTimer();

            console.log(`玩家${this.currentPlayer}思考时间到，自动切换到下一玩家`);
            if (onTimeout) {
                onTimeout();
            }
        }, this.THINKING_TIME);
    }

    // 清除思考时间计时器 (仅清除计时器，保留状态)
    pauseThinkingTimer() {
        if (this.thinkingTimer) {
            clearTimeout(this.thinkingTimer);
            this.thinkingTimer = null;
        }
    }

    // 恢复思考时间计时器
    resumeThinkingTimer(onTimeout) {
        if (!this.thinkingStartTime) return;
        
        // 确保清除旧的计时器
        if (this.thinkingTimer) {
            clearTimeout(this.thinkingTimer);
            this.thinkingTimer = null;
        }

        // 重新计算剩余时间
        const remaining = this.getRemainingThinkingTime();
        
        const playerAtStart = this.currentPlayer;
        const phaseAtStart = this.gamePhase;
        const startTime = this.thinkingStartTime;

        // 续上同一扇窗，上下文要按这颗计时器重建：
        // 之前若被 clearThinkingTimer 清过，回调会被当成过期而吞掉
        this._thinkingTimerContext = {
            startTime,
            player: playerAtStart,
            phase: phaseAtStart
        };
        this.thinkingTimerOwner = playerAtStart;

        this.thinkingTimer = setTimeout(() => {
            if (!this._thinkingTimerContext ||
                this._thinkingTimerContext.startTime !== startTime ||
                this.currentPlayer !== playerAtStart ||
                this.gamePhase !== phaseAtStart) {
                console.log('[思考计时] 忽略过期的超时回调 (恢复后)', {
                    expectedPlayer: playerAtStart,
                    currentPlayer: this.currentPlayer,
                    expectedPhase: phaseAtStart,
                    currentPhase: this.gamePhase
                });
                return;
            }
            this.clearThinkingTimer();

            console.log(`玩家${this.currentPlayer}思考时间到，自动切换到下一玩家`);
            if (onTimeout) {
                onTimeout();
            }
        }, remaining);
    }

    // 清除思考时间计时器及本地计时状态
    clearThinkingTimer() {
        if (this.thinkingTimer) {
            clearTimeout(this.thinkingTimer);
            this.thinkingTimer = null;
        }
        this._thinkingTimerContext = null;
        this.thinkingTimeRemaining = 0;
        this.pausedThinkingTime = 0;
        this.pauseStartTime = null;
        this.thinkingTimerOwner = null;
        // 不清 thinkingStartTime：它是服务端给这一回合的窗口起点，
        // 本地停计时器（换渲染、暂停）之后再起时还要靠它接着算，清掉就等于刷新续命
    }

    /** 换局/离开对局时把窗口起点也清掉 */
    clearThinkingWindow() {
        this.clearThinkingTimer();
        this.thinkingStartTime = null;
    }

    // 获取剩余思考时间
    getRemainingThinkingTime() {
        if (!this.thinkingStartTime) {
            return 0;
        }

        let elapsed = Date.now() - this.thinkingStartTime;

        // 如果当前处于暂停状态，减去暂停期间的时间
        if (this.isPaused && this.pauseStartTime) {
            elapsed -= (Date.now() - this.pauseStartTime);
        }

        // 减去之前累计的暂停时间
        elapsed -= this.pausedThinkingTime;
        const remaining = Math.max(0, this.THINKING_TIME - elapsed);
        this.thinkingTimeRemaining = remaining;
        return remaining;
    }

    // 获取思考时间进度（0-1）
    getThinkingProgress() {
        if (!this.thinkingStartTime) {
            return 0;
        }

        let elapsed = Date.now() - this.thinkingStartTime;

        // 如果当前处于暂停状态，减去暂停期间的时间
        if (this.isPaused && this.pauseStartTime) {
            elapsed -= (Date.now() - this.pauseStartTime);
        }

        // 减去之前累计的暂停时间
        elapsed -= this.pausedThinkingTime;

        return Math.min(1, elapsed / this.THINKING_TIME);
    }


    // 是否正在计时
    isThinkingTimerActive() {
        return this.thinkingTimer !== null;
    }

    /**
     * 进度条颜色归属：锁定在「计时器启动那一刻」的玩家。
     * 这是进度条不变色的根本保证——快照会把 currentPlayer 提前推给下家，
     * 但只要计时器还是上一位玩家的，进度条就维持上一位玩家的颜色。
     */
    getThinkingProgressOwner() {
        return this.thinkingTimerOwner ?? null;
    }

    /**
     * 进度条展示归属：掷骰/走子动画期间锁定为「本次掷骰者」，
     * 避免动画尚未播完时进度条就提前变成下家颜色。
     */
    setThinkingProgressDisplayOwner(player) {
        this.thinkingProgressDisplayOwner = player ?? null;
    }

    clearThinkingProgressDisplayOwner() {
        this.thinkingProgressDisplayOwner = null;
    }

    getThinkingProgressDisplayOwner() {
        return this.thinkingProgressDisplayOwner ?? null;
    }

    // 处理思考时间超时
    handleThinkingTimeout() {
        // 检查游戏是否暂停，如果暂停则不执行超时逻辑
        if (this.getIsPaused()) {
            console.log('游戏已暂停，忽略思考超时');
            return {
                shouldUpdateUI: false,
                shouldStartNewTimer: false
            };
        }


        // 清除计时器
        this.clearThinkingTimer();
        // 联机模式：超时托管必须按 playerId 精确同步，出手一律由服务端执行。
        // 绝对不要在这里开启本地“全局AI托管”（aiTakeoverManager.enableTakeover），否则会把房主 UI/昵称错误地标记为 AI。
        if (this.isOnlineMultiplayer) {
            try {
                const mgm = window.gameInstance?.multiplayerGameManager;
                const currentPlayerNumber = this.currentPlayer;
                const currentPlayerId = mgm && typeof mgm.getPlayerIdByPlayerNumber === 'function'
                    ? mgm.getPlayerIdByPlayerNumber(currentPlayerNumber)
                    : null;

                if (mgm && mgm.isHost && currentPlayerId && typeof mgm.sendMessage === 'function') {
                    mgm.sendMessage('aiTakeoverChange', {
                        playerId: currentPlayerId,
                        isActive: true,
                        auto: true,
                        timestamp: Date.now(),
                        reason: 'thinking_timeout'
                    });
                }
            } catch (e) {
                // ignore
            }
            // 即使 multiplayerGameManager 尚未就绪，也不要回退到本地全局托管。
            return {
                shouldUpdateUI: false,
                shouldStartNewTimer: false
            };
        }

        // 如果当前阶段是选择棋子
        if (this.gamePhase === 'selecting') {
            // 统一策略：只要在selecting阶段思考超时，一律开启AI托管，由AI代为完成本回合操作
            // 传送门模式下同样走托管逻辑，具体棋子选择由AI完成
            (async () => {
                try {
                    const module = await import('./aiTakeoverManager.js');
                    if (module && module.aiTakeoverManager && typeof module.aiTakeoverManager.enableTakeover === 'function') {
                        module.aiTakeoverManager.enableTakeover();
                    }
                } catch (error) {
                    console.error('selecting阶段思考超时开启AI托管失败:', error);
                }
            })();

            return {
                shouldUpdateUI: false,
                shouldStartNewTimer: false
            };
        }

        // 如果是掷骰子阶段
        if (this.gamePhase === 'rolling') {
            // 注意：超时消息已经在 dice.handleThinkingTimeoutWrapper 中添加，此处不重复添加

            // 超时时直接开启AI托管，由AI代为完成当前玩家本回合的操作
            (async () => {
                try {
                    const module = await import('./aiTakeoverManager.js');
                    if (module && module.aiTakeoverManager && typeof module.aiTakeoverManager.enableTakeover === 'function') {
                        module.aiTakeoverManager.enableTakeover();
                    }
                } catch (error) {
                    console.error('掷骰子阶段思考超时开启AI托管失败:', error);
                }
            })();

            return {
                shouldUpdateUI: false,
                shouldStartNewTimer: false
            };
        }

        return {
            shouldUpdateUI: false,
            shouldStartNewTimer: false
        };
    }


    // 获取击败次数
    getDefeatCount(attackerPlayer, defeatedPlayer) {
        if (this.defeatCounts[attackerPlayer] && this.defeatCounts[attackerPlayer][defeatedPlayer] !== undefined) {
            return this.defeatCounts[attackerPlayer][defeatedPlayer];
        }
        return 0;
    }

    // 获取游戏暂停状态
    getIsPaused() {
        return this.isPaused;
    }

    // 设置游戏暂停状态
    setIsPaused(paused) {
        if (this.isPaused === paused) {
            return; // 状态没有改变
        }

        if (paused) {
            // 开始暂停 - 保存当前状态
            this.gamePhaseBeforePause = this.gamePhase;
            this.currentPlayerBeforePause = this.currentPlayer;
            this.pauseStartTime = Date.now();
            // 暂停思考计时器，不清除状态
            this.pauseThinkingTimer();
            // 强制清除AI决策状态
            this.setAIDecisionInProgress(false);
            // 显示暂停提示
            this.showPauseIndicator();
        } else {
            // 结束暂停
            if (this.pauseStartTime) {
                // 累计暂停时间
                this.pausedThinkingTime += (Date.now() - this.pauseStartTime);
                this.pauseStartTime = null;
            }
            // 注意：恢复思考计时器由 gameMain.js 中的 resumeGame 方法处理
            
            // 隐藏暂停提示
            this.hidePauseIndicator();
        }

        this.isPaused = paused;
    }
    /**
     * 显示加载提示并隐藏游戏控件
     */
    showPauseIndicator() {
        const pauseIndicator = document.getElementById('pauseIndicator');
        const diceDisplay = document.getElementById('diceDisplay');
        const thinkingProgressContainer = document.getElementById('thinkingProgressContainer');
        
        if (pauseIndicator) {
            pauseIndicator.style.display = 'flex';
        }

        // 隐藏所有可能与暂停提示重叠的中心区域UI
        const centerUIElements = [
            'polyhedralDiceDisplay',
            'teleportIcon',
            'mysteryBoxIcon',
            'diceSelectionPanel'
        ];
        
        centerUIElements.forEach(id => {
            const element = document.getElementById(id);
            if (element && element.style.display !== 'none') {
                // 标记这些元素是因为暂停而被隐藏的，以便恢复
                element.dataset.hiddenByPause = 'true';
                element.style.display = 'none';
            }
        });

        // 检查聊天输入框是否正在显示，如果是则不隐藏骰子
        const chatInputArea = document.getElementById('chatInputArea');
        if (diceDisplay && !(chatInputArea && chatInputArea.style.display === 'flex')) {
            diceDisplay.style.display = 'none';
        }

        // 暂停期间进度条整段隐藏；这里只摘 active，不写内联 display
        if (thinkingProgressContainer) {
            thinkingProgressContainer.classList.remove('active');
        }

    }

    /**
     * 隐藏加载提示并显示游戏控件
     */
    hidePauseIndicator() {
        const pauseIndicator = document.getElementById('pauseIndicator');
        const diceDisplay = document.getElementById('diceDisplay');
        const thinkingProgressContainer = document.getElementById('thinkingProgressContainer');

        if (pauseIndicator) {
            pauseIndicator.style.display = 'none';
        }

        // 恢复因暂停而被隐藏的中心区域UI
        const centerUIElements = [
            'polyhedralDiceDisplay',
            'teleportIcon',
            'mysteryBoxIcon',
            'diceSelectionPanel'
        ];
        
        centerUIElements.forEach(id => {
            const element = document.getElementById(id);
            if (element && element.dataset.hiddenByPause === 'true') {
                element.style.display = id === 'diceSelectionPanel' ? 'block' : 'flex';
                delete element.dataset.hiddenByPause;
            }
        });

        // 使用 uiUpdater 统一管理骰子显示逻辑，避免与其他UI（聊天、道具等）冲突
        if (window.uiUpdater && typeof window.uiUpdater.updateDiceDisplay === 'function') {
            window.uiUpdater.updateDiceDisplay();
        } else if (diceDisplay) {
            const chatInputArea = document.getElementById('chatInputArea');
            if (!(chatInputArea && window.getComputedStyle(chatInputArea).display !== 'none')) {
                diceDisplay.style.display = 'flex';
            }
        }

        // 进度条可见性统一交给渲染器（基于计时器），避免内联 display 盖过 .active
        window.uiUpdater?._renderThinkingProgressBar?.();
    }

    // 切换游戏暂停状态
    togglePause() {
        const newPauseState = !this.isPaused;
        this.setIsPaused(newPauseState);
        return this.isPaused;
    }

    // 记录游戏开始时间
    recordGameStartTime() {
        this.gameStartTime = Date.now();
    }

    // 记录游戏结束时间
    recordGameEndTime() {
        this.gameEndTime = Date.now();
    }

    // 获取游戏持续时间（毫秒）
    getGameDuration() {
        if (!this.gameStartTime) return 0;
        const endTime = this.gameEndTime || Date.now();
        return endTime - this.gameStartTime;
    }

    // 格式化游戏持续时间为 "分'秒''" 格式
    getFormattedGameDuration() {
        const duration = this.getGameDuration();
        const totalSeconds = Math.floor(duration / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}'${seconds.toString().padStart(2, '0')}''`;
    }

    // 电脑玩家配置相关方法
    setBotPlayers(botPlayers) {
        this.botPlayers = new Set(botPlayers);
    }

    isBotPlayer(player) {
        return this.botPlayers.has(player);
    }

    getBotPlayers() {
        return Array.from(this.botPlayers);
    }

    // AI托管状态管理
    getIsAITakeover() {
        return this.isAITakeover;
    }

    setAITakeover(takeover) {
        this.isAITakeover = takeover;
        console.log(`AI托管${takeover ? '开启' : '关闭'}`);
    }

    // AI决策进行中状态管理
    getAIDecisionInProgress() {
        return this.aiDecisionInProgress;
    }
    // 设置AI决策状态
    setAIDecisionInProgress(inProgress) {
        this.aiDecisionInProgress = inProgress;
    }

    // 三次6惩罚状态管理
    getThreeSixesPenaltyActive() {
        return this.isThreeSixesPenaltyActive;
    }

    setThreeSixesPenaltyActive(active) {
        this.isThreeSixesPenaltyActive = active;
    }


    setChessMoving(moving) {
        this.chessMoving = moving;
    }

    /**
     * 保存当前回合的完成度数据
     */
    saveProgressSnapshot() {
        // 如果progressDisplay还未初始化，则跳过
        if (!window.gameInstance || !window.gameInstance.progressDisplay) {
            return;
        }

        // 联机模式的完成度历史由服务端权威记录并随快照下发，客户端不再采集
        if (this.isOnlineMultiplayer) {
            return;
        }

        const progressDisplay = window.gameInstance.progressDisplay;

        // 采样策略：前100回合每次都记录，之后每5回合记录一次
        const shouldSave = this.currentRound <= 100 || this.currentRound % 5 === 0;
        if (!shouldSave) {
            return;
        }

        // 检查是否已经存在相同回合的快照（防止重连后重复记录）
        const existingIndex = this.progressHistory.findIndex(s => s.round === this.currentRound);
        if (existingIndex !== -1) {
            return;
        }

        const snapshot = {
            round: this.currentRound,
            players: {}
        };

        // 获取激活的玩家列表
        const activePlayers = activePlayerManager ? activePlayerManager.getActivePlayers() : [1, 2, 3, 4];

        // 记录每个激活玩家的完成度
        activePlayers.forEach(player => {
            const progress = progressDisplay.calculatePlayerProgress(player, this);
            snapshot.players[player] = progress;
        });

        this.progressHistory.push(snapshot);

        // 限制历史记录数量，防止内存溢出
        if (this.progressHistory.length > this.MAX_PROGRESS_HISTORY) {
            // 删除最早的数据，保留最近的数据
            this.progressHistory.shift();
        }

        // console.log(`保存第${this.currentRound}回合完成度快照 (总计${this.progressHistory.length}条):`, snapshot);
    }

    /**
     * 清理历史数据（游戏结束或重新开始时调用）
     */
    clearProgressHistory() {
        this.progressHistory = [];
        this.currentRound = 0;
        console.log('已清理完成度历史记录');
    }

    /**
     * 请求暂停：点击当刻生效（等「安全时机」会因错过回调而永远停在「等待暂停...」）。
     * 进行中的动画不强杀，但暂停期间不放行新的操作、计时器与 AI 动作。
     */
    requestSafePause() {
        this.setIsPaused(true);
        return true;
    }
}


// 创建并导出游戏状态实例
export const gameState = new GameState();
export default GameState;