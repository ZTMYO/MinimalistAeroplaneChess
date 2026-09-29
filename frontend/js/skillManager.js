import { energyManager } from './energyManager.js';
import { gameState } from './gameState.js';
import { ITEM_COSTS } from '../../shared/engine.mjs';
import { DICE_SYMBOLS } from './utils.js';
import { engineAdapter } from './engineAdapter.js';

/** 道具价目只有引擎那一份；界面上的价签也由它写，免得 HTML 里的数字悄悄过期 */
const priceOf = (skillId) => ITEM_COSTS[skillId] || 0;
import { enginePlayback } from './enginePlayback.js';

class SkillManager {
    constructor() {
        this.skillPanel = null;
        this.skillBtn = null;
        this.skillEnergyText = null;
        this.isPanelOpen = false;
        this.currentNotification = null;
        this.notificationTimeout = null;
        this.hintTimer = null;
    }

    /**
     * 初始化道具管理器
     */
    init() {
        // 检查是否启用道具模式
        const isSpectator = window.multiplayerGameManager && window.multiplayerGameManager.isSpectator;
        if (!energyManager.isSkillModeEnabled() || isSpectator) {
            // 隐藏道具按钮
            const skillBtn = document.getElementById('skillBtn');
            if (skillBtn) {
                skillBtn.classList.add('is-hidden');
                skillBtn.style.display = 'none';
            }
            return;
        }

        this.skillPanel = document.getElementById('skillPanel');
        this.skillBtn = document.getElementById('skillBtn');
        this.skillEnergyText = document.getElementById('skillEnergyText');

        if (!this.skillPanel || !this.skillBtn) {
            return;
        }
        // 绑定道具按钮点击事件
        this.skillBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePanel();
        });

        // 绑定道具项点击事件
        this.bindSkillItemEvents();

        // 点击其他地方关闭面板
        document.addEventListener('click', (e) => {
            if (this.isPanelOpen &&
                !this.skillPanel.contains(e.target) &&
                !this.skillBtn.contains(e.target)) {
                this.closePanel();
            }
        });

        // 初始化积分显示
        this.updateEnergyDisplay();

        // 启动提示定时器
        this.startHintTimer();

    }

    /**
     * 启动提示定时器
     */
    startHintTimer() {
        if (this.hintTimer) return;

        this.hintTimer = setInterval(() => {
            this.checkAndShowHint();
        }, 3000); // 每 3 秒检查一次
    }

    /**
     * 停止提示定时器
     */
    stopHintTimer() {
        if (this.hintTimer) {
            clearInterval(this.hintTimer);
            this.hintTimer = null;
        }
    }

    /**
     * 检查是否需要显示提示
     */
    checkAndShowHint() {
        if (!this.skillBtn) return;

        const localPlayer = this._panelPlayer();

        // 检查是否轮到本地玩家，且能量已满
        const isMyTurn = gameState.getCurrentPlayer() === localPlayer;
        const currentEnergy = energyManager.getEnergy(localPlayer);
        const isEnergyFull = currentEnergy >= energyManager.maxEnergy;

        if (isMyTurn && isEnergyFull && !this.isPanelOpen) {
            this.skillBtn.classList.remove('skill-btn-hint');
            // 触发重绘以重新开始动画
            void this.skillBtn.offsetWidth;
            this.skillBtn.classList.add('skill-btn-hint');
        } else {
            this.skillBtn.classList.remove('skill-btn-hint');
        }
    }



    /**
     * 绑定道具项点击事件
     */
    bindSkillItemEvents() {
        const skillItems = document.querySelectorAll('.skill-item');
        skillItems.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleSkillClick(item);
            });
        });
    }

    /**
     * 更新道具按钮的显示/隐藏状态
     */
    updateButtonVisibility() {
        const skillBtn = document.getElementById('skillBtn');
        if (!skillBtn) return;
        const isSpectator = window.multiplayerGameManager && window.multiplayerGameManager.isSpectator;
        const isSkillMode = energyManager.isSkillModeEnabled();
        const loadingIndicator = document.getElementById('loadingIndicator');
        const isLoading = loadingIndicator && loadingIndicator.style.display === 'flex';
        // 检查是否处于AI托管状态
        const isAITakeoverActive = window.aiTakeoverManager && window.aiTakeoverManager.isActive;

        // 如果AI托管正在运行，则不显示技能按钮
        if (isSpectator || !isSkillMode || isLoading || isAITakeoverActive) {
            skillBtn.style.display = 'none';
        } else {
            skillBtn.style.display = 'block';
        }
    }

    /**
     * 处理道具点击
     * @param {HTMLElement} skillItem - 道具项元素
     */
    handleSkillClick(skillItem) {
        const skillId = skillItem.dataset.skill;
        const cost = priceOf(skillId);

        console.log(`道具点击: ${skillId}, 消耗: ${cost}积分`);

        // 看自己那一席：联机=本人，本地多人=当前回合的人，人机=自己的座位
        const localPlayer = this._panelPlayer();

        // 检查是否是当前玩家的回合
        const currentPlayer = gameState.getCurrentPlayer();
        if (currentPlayer !== localPlayer) {
            console.log('不是当前玩家的回合，无法使用道具');
            this.showNotification('请等待你的回合！');
            return;
        }

        // 检查游戏阶段（必须是rolling阶段且骰子值为0，即还未投掷）
        const gamePhase = gameState.getGamePhase();
        const diceValue = gameState.getDiceValue();
        if (gamePhase !== 'rolling' || diceValue !== 0) {
            console.log(`无法使用道具: 阶段=${gamePhase}, 骰子值=${diceValue}`);
            this.showNotification('只能在投掷前使用道具！');
            return;
        }

        // 检查积分是否足够
        const currentEnergy = energyManager.getEnergy(localPlayer);
        if (currentEnergy < cost) {
            console.log(`积分不足: 当前${currentEnergy}, 需要${cost}`);
            return;
        }

        // 如果是传送门道具，检查是否有可传送的棋子
        if (skillId === 'teleport') {
            const hasChessOnTrack = this.checkHasChessOnTrack(localPlayer);
            if (!hasChessOnTrack) {
                this.showNotification('没有可传送的棋子！所有棋子都在基地');
                return;
            }
        }

        // 使用道具
        this.useSkill(skillId, localPlayer);
    }

    /**
     * 检查玩家是否有棋子在轨道上（不在基地）
     * @param {number} player - 玩家编号
     * @returns {boolean} 是否有棋子在轨道上
     */
    checkHasChessOnTrack(player) {
        const playerChess = gameState.getPlayerChess()[player];
        const pieceCount = gameState.pieceCount || 4;

        for (let i = 0; i < pieceCount; i++) {
            const chess = playerChess[i];
            // 只要有一个棋子不在基地（position !== -1）且未完成，就返回true
            if (chess.position !== -1 && !chess.finished) {
                return true;
            }
        }

        return false;
    }

    /**
     * 使用道具。买道具的账由引擎记：联机由服务端裁决，单机落到本地引擎，
     * 客户端只负责发起与播放表现（不再自己扣分，也不再往外同步积分）。
     * @param {string} skillId - 道具ID
     * @param {number} player - 玩家编号
     */
    useSkill(skillId, player) {
        console.log(`玩家${player}使用道具: ${skillId}`);

        // 道具使用次数不在这里记：它由权威事件流统一记录（见 enginePlayback.recordItemUsage），
        // 各端数字一致，刷新后也能从事件流重建。这里再记一次会重复计数。

        // 播放道具音效
        if (audioManager) {
            audioManager.playSkillSound();
        }

        // 实现具体的道具效果
        switch (skillId) {
            case 'remote-dice':
                this.activateRemoteDice(player);
                break;
            case 'teleport':
                this.activateTeleport(player);
                break;
            case 'polyhedral-dice':
                this.activatePolyhedralDice(player);
                break;
            case 'mysteryBox':
                this.activateMysteryBox(player);
                break;
            default:
                console.warn(`未知的道具: ${skillId}`);
        }

        // 关闭面板
        this.closePanel();

        // 更新积分显示
        this.updateEnergyDisplay();
        this.updateSkillAvailability();
    }

    /**
     * 激活遥控骰子道具
     * @param {number} player - 玩家编号
     */
    activateRemoteDice(player) {
        console.log(`玩家${player}激活遥控骰子道具`);

        // 上报激活态：点数还没选，只登记「道具已在手上」，刷新后据此重开面板。
        // 联机时这一笔账由服务端扣，单机落到本地引擎
        if (!this.buyItem('remote-dice')) return;

        // 骰子立刻换成遥控骰子的青色（还没投掷也是这个色，别再是默认的灰骰子）
        gameState.isRemoteDice = true;
        document.getElementById('diceDisplay')?.classList.add('remote-dice');

        let shouldShowPanel = true;
        if (window.gameInfo && window.gameInfo.isNonLocalPlayer) {
            shouldShowPanel = !window.gameInfo.isNonLocalPlayer(player);
        } else if (window.botController && window.botController.isCurrentPlayerBot()) {
            shouldShowPanel = false;
        }
        
        if (shouldShowPanel) {
            // 本地玩家：暂时不再提前发送不带点数的消息，统一在选择完点数后发送
            this.showDiceSelectionPanel(player);
        } else {
            // 非本地玩家：暂不发送消息，等真正选择点数(handleDiceSelection)时再发包含点数的消息
        }
    }

    /**
     * 买下道具：联机只上报意图（服务端扣分并把激活态写进快照），
     * 单机直接落到本地引擎（同一个 item 动作，同一份积分规则）。
     * @returns {boolean} 是否可以继续这道具的后续流程
     */
    buyItem(item) {
        if (item === 'remote-dice') this._remoteDicePicked = false;
        if (gameState.getIsOnlineMultiplayer()) {
            this.reportItemActivation(item);
            return true;
        }
        try {
            const { events } = engineAdapter.activateItem(item);
            engineAdapter.projectTo(gameState);
            // 单机没有快照回来，扣分后的账要立刻落到进度条上
            energyManager.applySnapshot(engineAdapter.state.energy);
            this.updateSkillAvailability();
            return true;
        } catch (error) {
            console.error('引擎拒绝购买道具:', error);
            // 引擎拒的原因不止一种，照实说，别一律报「积分不足」
            this.showNotification(/未开启道具模式/.test(error?.message || '') ? '本局未开启道具模式' : '积分不足');
            return false;
        }
    }

    /** 取消已激活的道具：预扣的积分退回来（联机由服务端退，单机落到本地引擎） */
    cancelItem() {
        // 撤掉遥控骰子：骰面收回默认状态
        gameState.isRemoteDice = false;
        document.getElementById('diceDisplay')?.classList.remove('remote-dice');

        if (gameState.getIsOnlineMultiplayer()) {
            this.reportItemActivation(null);
            return;
        }
        try {
            engineAdapter.cancelItem();
            engineAdapter.projectTo(gameState);
            energyManager.applySnapshot(engineAdapter.state.energy);
            this.updateSkillAvailability();
        } catch (error) {
            // 没有待取消的激活态：无事可做
        }
    }

    /** 上报道具激活（单机无服务端，静默跳过）；item 传 null 表示取消激活 */
    reportItemActivation(item) {
        // 新的一次激活：选点标记复位，面板该开就开
        if (item === 'remote-dice') this._remoteDicePicked = false;
        const manager = window.gameInstance && window.gameInstance.multiplayerGameManager;
        if (!gameState.getIsOnlineMultiplayer() || !manager) return;
        if (typeof manager.sendIntent !== 'function') return;
        manager.sendIntent({ type: 'item', item: item || null });
    }

    /** 选点意图被服务端拒绝：面板可以重新开，让玩家再选一次 */
    resetRemoteDiceSelection() {
        this._remoteDicePicked = false;
    }

    /**
     * 显示骰子点数选择面板
     * @param {number} player - 玩家编号
     */
    showDiceSelectionPanel(player) {
        // 暂停当前回合的思考时间进度条（掷骰/走子阶段）
        if (window.gameInstance && window.gameInstance.uiUpdater) {
            window.gameInstance.uiUpdater.holdThinkingProgressBar?.();
        } else if (gameState.clearThinkingTimer) {
            gameState.clearThinkingTimer();
        }

        // 如果已存在面板，先移除
        const existingPanel = document.getElementById('diceSelectionPanel');
        if (existingPanel) {
            existingPanel.remove();
        }

        // 创建选择面板
        const panel = document.createElement('div');
        panel.className = 'dice-selection-panel';
        panel.id = 'diceSelectionPanel';

        // 创建标题
        const title = document.createElement('h3');
        title.textContent = '选择骰子点数';

        // 创建骰子点数按钮容器
        const diceContainer = document.createElement('div');
        diceContainer.className = 'dice-selection-container';

        // 创建骰子点数按钮（1-6）
        for (let i = 1; i <= 6; i++) {
            const btn = document.createElement('button');
            btn.textContent = DICE_SYMBOLS[i - 1];
            btn.className = 'dice-selection-btn';
            btn.addEventListener('click', () => {
                this.handleDiceSelection(i, player, panel);
            });
            diceContainer.appendChild(btn);
        }

        panel.appendChild(title);
        panel.appendChild(diceContainer);

        // 添加到game-controls-center容器中（与表情面板同级）
        const gameControlsCenter = document.querySelector('.game-controls-center');
        if (gameControlsCenter) {
            gameControlsCenter.appendChild(panel);
        } else {
            // 如果找不到容器，降级到body
            document.body.appendChild(panel);
        }

        // 检查聊天输入框是否正在显示，如果是则临时隐藏但标记应该显示
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        if (isChatInputVisible) {
            // 不再隐藏面板，让用户可以选择骰子点数
            console.log('聊天输入框显示中，但骰子选择面板仍然可见');
        }

        this.armDiceSelectionTimeout(player);
    }

    /** 遥控骰子选点的超时：按服务端给的思考窗口计时，超时开 AI 托管 */
    armDiceSelectionTimeout(player) {
        const uiUpdater = window.gameInstance && window.gameInstance.uiUpdater;
        if (!uiUpdater?.startThinkingProgressBar) return;

        uiUpdater.startThinkingProgressBar(() => {
            console.log(`[遥控骰子] 玩家${player}选择点数思考时间到，开启AI托管`);

            // 面板已经被关掉说明玩家已选好点数，忽略这次超时
            if (!document.getElementById('diceSelectionPanel')) return;

            (async () => {
                try {
                    const module = await import('./aiTakeoverManager.js');
                    if (module && module.aiTakeoverManager && typeof module.aiTakeoverManager.enableTakeover === 'function') {
                        module.aiTakeoverManager.enableTakeover();
                    }
                } catch (error) {
                    console.error('遥控骰子选择超时开启AI托管失败:', error);
                }
            })();
        });
    }

    /**
     * 处理骰子点数选择
     * @param {number} diceValue - 选择的骰子点数
     * @param {number} player - 玩家编号
     * @param {HTMLElement} panel - 面板元素
     */
    async handleDiceSelection(diceValue, player, panel) {
        // 已选点：激活态落地前若再来一份快照，不要再把面板开回来
        this._remoteDicePicked = true;
        this._remoteDicePickedValue = diceValue;

        // AI 代选不会传 panel，按 id 兜底清掉，避免留下作废的选点面板
        const panelEl = panel || document.getElementById('diceSelectionPanel');
        if (panelEl && panelEl.parentNode) {
            panelEl.parentNode.removeChild(panelEl);
        }

        // 选完点数照常走掷骰流程（闪烁 → 定格 → 提交意图）：
        // 遥控骰子只是把点数预先定死，动画与手感跟手投完全一样
        const dice = window.gameInstance && window.gameInstance.dice;
        if (dice && typeof dice.rollDice === 'function') {
            dice.presetDiceValue = diceValue;
            await dice.rollDice();
            return;
        }

        // 兜底：没有骰子实例（极端时序）时退回直接提交意图
        gameState.diceValue = diceValue;
        gameState.isRemoteDice = true;
        if (gameState.getIsOnlineMultiplayer() && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            window.gameInstance.multiplayerGameManager.sendIntent({
                type: 'roll',
                item: 'remote-dice',
                value: diceValue
            });
            return;
        }
        await this.applyItemRoll(player, diceValue, 6, 'remote-dice');
    }

    /**
     * 激活传送门道具
     * @param {number} player - 玩家编号
     */
    activateTeleport(player) {
        console.log(`玩家${player}激活传送门道具`);

        // 买下传送门：联机由服务端扣分并记激活态，单机落到本地引擎。
        // 买不起就别点亮图标，免得看着能用却选不出落点
        if (!this.buyItem('teleport')) return;

        // 在骰子位置显示传送门图标
        this.showTeleportIcon();

        // 在线模式下让其他客户端立刻看到图标（收起由快照负责）
        if (gameState.getIsOnlineMultiplayer() && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            window.gameInstance.multiplayerGameManager.syncTeleportIcon();
        }

        // 设置传送门模式标记
        if (window.gameInstance) {
            window.gameInstance.isTeleportMode = true;
        }

        // 直接进入选择棋子阶段
        gameState.setGamePhase('selecting');
        gameState.setDiceValue(999); // 使用特殊值标记传送门模式，避免与正常骰子值冲突

        // 立刻重画一次：可传送的棋子要按「可移动」那套高亮起来
        window.gameInstance?.uiUpdater?.updateUI?.();

        // 仅当当前玩家不是由AI控制时，才显示提示文字
        if (!window.botController || !window.botController.isCurrentPlayerBot()) {
            this.showNotification('传送门已激活！选择棋子进行传送');
        }

        // 触发 bot 操作
        if (window.gameInstance && window.gameInstance.dice && window.gameInstance.dice.triggerBotOperationIfNeeded) {
            window.gameInstance.dice.triggerBotOperationIfNeeded();
        }
    }

    /**
     * 激活多面骰子道具
     * @param {number} player - 玩家编号
     */
    async activatePolyhedralDice(player) {
        console.log(`玩家${player}激活多面骰子道具`);

        // 联机模式：点数由服务端摇出并下发，本地不自行生成；
        // 这一掷同时把道具钱扣掉（引擎在 roll 动作里收费）
        if (gameState.getIsOnlineMultiplayer() && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            window.gameInstance.multiplayerGameManager.sendIntent({
                type: 'roll',
                item: 'polyhedral-dice'
            });
            return;
        }

        // 单机：点数由引擎摇，本地只播表现
        await this.applyItemRoll(player, null, 12, 'polyhedral-dice');
    }

    /**
     * 单机道具骰子统一入口：把点数交给共享引擎裁决，再回放事件流。
     * 引擎的 noBonus 语义保证道具骰子不参与连投奖励与三次 6 计数，与联机一致。
     * @param {number} player - 玩家编号
     * @param {number} diceValue - 道具给定的点数
     * @param {number} maxDice - 点数上限（遥控骰子 6、多面骰 12）
     * @param {string} item - 道具 id，写进事件流与快照
     */
    async applyItemRoll(player, diceValue, maxDice, item = null) {
        const gameInstance = window.gameInstance;
        if (!gameInstance || !gameInstance.chessPiece) return;

        const chessPiece = gameInstance.chessPiece;
        chessPiece.gameState.setChessMoving(true);
        try {
            const { events } = engineAdapter.itemRoll(diceValue, maxDice, item);
            // 多面骰：先亮数字牌滚轮 + 投掷音效，再演事件流（联机那条路由快照触发同样的演出）
            if (item === 'polyhedral-dice') {
                const rolled = engineAdapter.state.dice;
                if (rolled > 0) this.showPolyhedralDice(rolled);
                window.audioManager?.playRollingSound?.();
            }
            const shake = await enginePlayback.play(events);
            engineAdapter.projectTo(chessPiece.gameState);
            // 道具骰子也可能无子可动（比如遥控骰子选了个奇数）：抖动照播
            if (shake) await enginePlayback.playDiceShake(shake);

            const state = engineAdapter.state;
            chessPiece.gameState.isRolling = false;
            // 道具骰子不参与连投奖励
            chessPiece.gameState.canReroll = false;

            if (state.phase === 'ended') {
                chessPiece.gameState.recordGameEndTime();
                if (window.progressDisplay) {
                    chessPiece.gameState.saveProgressSnapshot();
                }
                setTimeout(() => {
                    if (window.main && window.main.settlementModal) {
                        window.main.settlementModal.show(state.winner);
                    }
                }, 1000);
            } else if (state.phase === 'selecting') {
                // 有可动棋子：停在选子阶段，由玩家选子后走 handleEngineMove
                chessPiece.uiUpdater.updateUI();
                chessPiece.triggerBotOperationIfNeeded();
            } else {
                // 引擎已自动结束回合（无可动棋子）
                chessPiece.handleMoveComplete(player);
            }

            if (gameInstance.uiUpdater) gameInstance.uiUpdater.updateUI();
        } catch (error) {
            console.error('引擎拒绝本次道具骰子:', error);
            engineAdapter.projectTo(chessPiece.gameState);
            chessPiece.gameState.isRolling = false;
            if (gameInstance.uiUpdater) gameInstance.uiUpdater.updateUI();
        } finally {
            // 引擎扣过道具钱，进度条按权威积分对齐
            energyManager.applySnapshot(engineAdapter.state.energy);
            this.updateSkillAvailability();
            chessPiece.gameState.setChessMoving(false);
        }
    }

    /**
     * 使用盲盒：开出的积分与放弃回合都由引擎一次算完（联机报告意图、单机落到本地引擎），
     * 开盒演出由事件流里的 mystery_box 事件驱动，各端看到同一个数。
     * @param {number} player - 玩家编号
     */
    async activateMysteryBox(player) {
        console.log(`玩家${player}激活盲盒道具`);

        if (window.gameInstance?.uiUpdater) {
            window.gameInstance.uiUpdater.holdThinkingProgressBar?.();
        }

        if (gameState.getIsOnlineMultiplayer() && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            window.gameInstance.multiplayerGameManager.sendIntent({ type: 'item', item: 'mysteryBox' });
            return;
        }

        const gameInstance = window.gameInstance;
        const chessPiece = gameInstance && gameInstance.chessPiece;
        if (!chessPiece) return;

        try {
            const { events } = engineAdapter.activateItem('mysteryBox');
            await enginePlayback.play(events);
            engineAdapter.projectTo(chessPiece.gameState);
            energyManager.applySnapshot(engineAdapter.state.energy);
            this.updateSkillAvailability();
            chessPiece.handleMoveComplete(player);
            if (gameInstance.uiUpdater) gameInstance.uiUpdater.updateUI();
        } catch (error) {
            console.error('引擎拒绝盲盒:', error);
            engineAdapter.projectTo(chessPiece.gameState);
            if (gameInstance.uiUpdater) gameInstance.uiUpdater.updateUI();
        }

        // 下家若是AI需主动触发其回合；AI 自己用盲盒时 isProcessing 仍为 true，
        // 会被 triggerBotOperationIfNeeded 的安全守卫跳过，由 botController 收尾时自行接上
        if (window.eventHandler && typeof window.eventHandler.triggerBotOperationIfNeeded === 'function') {
            window.eventHandler.triggerBotOperationIfNeeded();
        }
    }

    /**
     * 显示多面骰子（1-12的随机点数）
     * @param {number} diceValue - 骰子点数（1-12）
     * @param {Object} [options]
     * @param {boolean} [options.instant] - 直接落在最终数字上，不播滚轮（刷新恢复）
     */
    showPolyhedralDice(diceValue, { instant = false } = {}) {
        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay) return;

        diceDisplay.style.display = 'none';

        const currentPlayer = gameState.getCurrentPlayer();

        let polyhedralDice = document.getElementById('polyhedralDiceDisplay');
        let reelStrip;
        let viewport;

        if (!polyhedralDice) {
            polyhedralDice = document.createElement('div');
            polyhedralDice.id = 'polyhedralDiceDisplay';
            polyhedralDice.className = `polyhedral-dice-display player-${currentPlayer}-color`;

            viewport = document.createElement('div');
            viewport.className = 'reel-viewport';

            reelStrip = document.createElement('div');
            reelStrip.className = 'reel-strip';
            for (let i = 0; i < 7; i++) {
                for (let n = 1; n <= 12; n++) {
                    const span = document.createElement('span');
                    span.textContent = n;
                    reelStrip.appendChild(span);
                }
            }
            viewport.appendChild(reelStrip);
            polyhedralDice.appendChild(viewport);
            diceDisplay.parentNode.insertBefore(polyhedralDice, diceDisplay);
        } else {
            const existingNum = polyhedralDice.querySelector('.final-number');
            if (existingNum) existingNum.remove();
            viewport = polyhedralDice.querySelector('.reel-viewport');
            reelStrip = viewport ? viewport.querySelector('.reel-strip') : null;
            if (reelStrip) {
                reelStrip.style.display = '';
                reelStrip.style.transition = 'none';
            }
            polyhedralDice.className = `polyhedral-dice-display player-${currentPlayer}-color`;
        }

        if (!reelStrip) return;

        // 恢复场景直接摆最终数字：重播滚轮没有意义，还会和棋子落位抢注意力
        if (instant) {
            reelStrip.style.display = 'none';
            const finalNum = document.createElement('span');
            finalNum.className = 'final-number';
            finalNum.textContent = diceValue;
            viewport.appendChild(finalNum);
            this._polyhedralRevealUntil = 0;
            this._showPolyhedralDiceContainer(polyhedralDice);
            return;
        }

        // 动态读取实际数字高度和视口尺寸
        const sampleSpan = reelStrip.querySelector('span');
        const itemHeight = sampleSpan ? sampleSpan.offsetHeight : 44;
        const viewportHeight = viewport ? viewport.offsetHeight : 50;
        const centerOffset = (viewportHeight - itemHeight) / 2;

        const targetIndex = 5 * 12 + (diceValue - 1);
        const targetY = centerOffset - targetIndex * itemHeight;

        const startIndex = Math.floor(Math.random() * 4) * 12;
        const startY = centerOffset - startIndex * itemHeight;

        reelStrip.style.transition = 'none';
        reelStrip.style.transform = `translateY(${startY}px)`;
        void reelStrip.offsetHeight;

        // 一条曲线，快速 + 轻微过冲 + 自然归位
        reelStrip.style.transition = 'transform 0.65s cubic-bezier(0.1, 0.75, 0.25, 1.05)';
        reelStrip.style.transform = `translateY(${targetY}px)`;

        // 动画完成后隐藏字带，显示最终数字
        setTimeout(() => {
            reelStrip.style.display = 'none';
            if (!polyhedralDice.querySelector('.final-number')) {
                const finalNum = document.createElement('span');
                finalNum.className = 'final-number';
                finalNum.textContent = diceValue;
                viewport.appendChild(finalNum);
            }
        }, 1200);

        // 滚轮停稳前不许收牌（0.65s 滚完、1.2s 露数字），收牌由 hidePolyhedralDice 把关
        this._polyhedralRevealUntil = Date.now() + 1300;
        this._showPolyhedralDiceContainer(polyhedralDice);
    }

    /** 亮出多面骰子牌；聊天输入框占用时先藏起来并登记待恢复 */
    _showPolyhedralDiceContainer(polyhedralDice) {
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        if (isChatInputVisible) {
            polyhedralDice.style.display = 'none';
            polyhedralDice.dataset.shouldShow = 'true';
        } else {
            polyhedralDice.style.display = 'block';
        }
    }


    /**
     * 显示盲盒图标（暂停期间不演：演出会压在暂停提示上）
     */
    showMysteryBoxIcon(player) {
        if (gameState.getIsPaused?.()) return;
        this.markItemSettlement(1300);

        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay) return;
        const playerColor = getComputedStyle(document.documentElement).getPropertyValue(`--player-${player}-color`).trim() || '#FFD700';

        // 隐藏骰子
        diceDisplay.style.display = 'none';

        // 创建盲盒图标容器（如果不存在）
        let mysteryBoxIcon = document.getElementById('mysteryBoxIcon');
        if (!mysteryBoxIcon) {
            mysteryBoxIcon = document.createElement('div');
            mysteryBoxIcon.id = 'mysteryBoxIcon';
            mysteryBoxIcon.className = 'dice-icon dice-icon-centered';
            mysteryBoxIcon.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6.77694 4.71874C6.9227 4.57859 7.12001 4.5001 7.32555 4.50049H16.6776C16.8824 4.50049 17.0812 4.57853 17.2262 4.71874L19.4357 6.85816H4.56597L6.7784 4.71874H6.77694ZM3.47026 8.35865H20.5329L18.9812 18.7522C18.9808 18.9506 18.8991 19.1409 18.754 19.2812C18.6088 19.4216 18.4121 19.5006 18.2069 19.501H5.79633C5.59082 19.501 5.3937 19.4221 5.24824 19.2817C5.10279 19.1414 5.02087 18.9509 5.02048 18.7522L3.47026 8.35865ZM7.32555 3.00144C6.70818 3.00144 6.11621 3.23852 5.68118 3.66061L2.43727 6.79311C2.27536 6.94984 2.15287 7.14047 2.07926 7.35026C2.00565 7.56005 1.98289 7.7834 2.01274 8.00305L3.46874 18.7493C3.46874 19.9925 4.5107 21 5.79481 21H18.2054C19.491 21 20.5314 19.9925 20.5314 18.7507L21.9874 8.00305C22.0171 7.78328 21.9941 7.55987 21.9202 7.35007C21.8463 7.14027 21.7236 6.94971 21.5614 6.79311L18.3205 3.65917C17.8844 3.2373 17.2929 3.0002 16.6761 3H7.32555V3.00144ZM14.2319 9.70445C14.1714 9.64146 14.0977 9.59162 14.0158 9.55823C13.9338 9.52484 13.8455 9.50866 13.7566 9.51077H10.2481C10.1589 9.50846 10.0703 9.52453 9.98806 9.55793C9.90583 9.59132 9.83191 9.64127 9.77121 9.70445C9.70982 9.76129 9.66125 9.82981 9.62858 9.90569C9.5959 9.98157 9.57982 10.0632 9.58135 10.1453V11.2599C9.58135 11.4333 9.64412 11.5794 9.77121 11.7008C9.83378 11.7608 9.90832 11.8079 9.99029 11.8392C10.0723 11.8705 10.16 11.8854 10.2481 11.8829H10.9282C11.014 11.8843 11.0991 11.8689 11.1785 11.8376C11.2579 11.8063 11.3299 11.7598 11.3902 11.7008C11.4536 11.6447 11.5043 11.5767 11.5393 11.5008C11.5743 11.4249 11.5927 11.3429 11.5935 11.2599V10.9751H12.4097V12.2457L11.2676 13.3082C11.2039 13.3661 11.154 13.4367 11.1212 13.5151C11.0885 13.5934 11.0736 13.6777 11.0777 13.7621V14.4097C11.0777 14.5919 11.1405 14.7422 11.2676 14.8636C11.328 14.9228 11.4003 14.9695 11.4799 15.0008C11.5596 15.0321 11.645 15.0474 11.731 15.0458H12.4097C12.497 15.0477 12.5839 15.0326 12.6651 15.0015C12.7463 14.9703 12.8202 14.9237 12.8824 14.8643C12.9446 14.805 12.9938 14.7342 13.0272 14.6561C13.0605 14.578 13.0772 14.4942 13.0764 14.4097V13.8272L14.2319 12.7502C14.2932 12.6936 14.3416 12.6253 14.3743 12.5497C14.4069 12.4741 14.4231 12.3927 14.4218 12.3108V10.1439C14.4233 10.0617 14.4073 9.98013 14.3746 9.90425C14.3419 9.82837 14.2933 9.75985 14.2319 9.70301V9.70445ZM12.8582 15.9781C12.7976 15.9192 12.7253 15.8728 12.6456 15.8418C12.566 15.8107 12.4806 15.7956 12.3947 15.7975H11.7295C11.6439 15.7958 11.5588 15.811 11.4794 15.8421C11.4 15.8731 11.328 15.9194 11.2676 15.9781C11.2062 16.035 11.1576 16.1035 11.125 16.1794C11.0923 16.2553 11.0762 16.3369 11.0777 16.419V17.0667C11.0777 17.2401 11.1405 17.3876 11.2676 17.5076C11.326 17.5701 11.3976 17.6198 11.4775 17.6535C11.5574 17.6871 11.6439 17.7039 11.731 17.7027H12.3962C12.4834 17.7039 12.5698 17.6871 12.6497 17.6535C12.7296 17.6198 12.8012 17.5701 12.8596 17.5076C12.9245 17.4526 12.9762 17.3848 13.0113 17.3087C13.0464 17.2326 13.064 17.15 13.0629 17.0667V16.419C13.0638 16.3356 13.046 16.253 13.0106 16.1769C12.9753 16.1007 12.9232 16.0329 12.8582 15.9781Z" fill="currentColor"/>
                </svg>
            `;
            diceDisplay.parentNode.insertBefore(mysteryBoxIcon, diceDisplay);
        }
        
        // 设置图标颜色
        mysteryBoxIcon.style.color = playerColor;

        // 添加闪烁动画
        mysteryBoxIcon.classList.add('mysteryBox-glow-animation');

        // 检查聊天输入框是否正在显示，如果是则临时隐藏但标记应该显示
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        if (isChatInputVisible) {
            mysteryBoxIcon.style.display = 'none';
            mysteryBoxIcon.dataset.shouldShow = 'true';
            console.log('[盲盒] 聊天输入框正在显示，盲盒图标已创建但暂时隐藏');
        } else {
            mysteryBoxIcon.style.display = 'flex';
        }
    }

    /**
     * 移除盲盒图标
     * @param {boolean} shouldRestoreDice - 是否恢复骰子显示
     */
    removeMysteryBoxIcon(shouldRestoreDice = true) {
        const diceDisplay = document.getElementById('diceDisplay');
        const mysteryBoxIcon = document.getElementById('mysteryBoxIcon');

        // 检查聊天输入框是否正在显示，如果是则不恢复骰子显示
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';

        // 显示骰子（除非明确要求不显示，或者聊天输入框正在显示）
        if (shouldRestoreDice && diceDisplay && !isChatInputVisible) {
            diceDisplay.style.display = 'flex';
        }

        // 移除盲盒图标
        if (mysteryBoxIcon) {
            mysteryBoxIcon.remove();
        }
    }

    /**
     * 显示积分获得数值动画
     * @param {number} energyGain - 获得的积分数值
     * @param {number} player - 玩家编号（用于设置颜色）
     */
    showEnergyGainAnimation(energyGain, player) {
        // 暂停期间不演：积分数值会顶开暂停提示
        if (gameState.getIsPaused?.()) return;
        this.markItemSettlement(1100);

        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay) return;

        // 获取玩家颜色以设置动画的文字颜色变量
        const playerColor = getComputedStyle(document.documentElement).getPropertyValue(`--player-${player}-color`).trim() || '#FFD700';
        document.documentElement.style.setProperty('--text-color', playerColor);

        // 隐藏骰子
        diceDisplay.style.display = 'none';

        // 创建积分数值显示元素（样式由CSS控制）
        const energyText = document.createElement('div');
        energyText.id = 'energyGainText';
        energyText.className = `energy-gain-text player-${player}`;

        // 添加积分图标和积分数值
        energyText.innerHTML = `
            <span>+${energyGain}</span>
            <svg t="1777811441484" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1702" style="width: 38px; height: 38px; transform: translateY(4px);">
                <path d="M511.838 472.601c-173.757 0-358.398-56-358.398-159.679 0-103.684 184.641-159.762 358.398-159.762 173.761 0 358.402 56 358.402 159.68 0 103.679-184.64 159.761-358.402 159.761z m0-265.839c-188.718 0-304.636 61.839-304.636 106.078 0 44.242 115.918 106.16 304.636 106.16 188.722 0 304.64-61.84 304.64-106.16 0.001-44.321-115.917-106.078-304.64-106.078z m0 0" fill="currentColor" p-id="1703"></path>
                <path d="M511.838 594.039c-172.636 0-358.398-40.56-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.358 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.12-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1704"></path>
                <path d="M511.838 721.719c-172.636 0-358.398-40.559-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.359 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.121-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1705"></path>
                <path d="M511.838 869.961c-172.636 0-358.398-40.563-358.398-129.68v-24.402c0-14.797 12.078-26.797 26.879-26.797 14.801 0 26.883 12 26.883 26.797v24.402c0 22.719 103.679 76.078 304.636 76.078 200.96 0 304.64-53.359 304.64-76.078v-24.402c0-14.797 12-26.797 26.883-26.797 14.797 0 26.879 12 26.879 26.797v24.402c0 89.116-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1706"></path>
            </svg>
        `;

        // 插入到骰子的父容器中
        diceDisplay.parentNode.insertBefore(energyText, diceDisplay);

        // 检查聊天输入框是否正在显示，如果是则临时隐藏但标记应该显示
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        if (isChatInputVisible) {
            energyText.style.display = 'none';
            energyText.dataset.shouldShow = 'true';
            console.log('[盲盒] 聊天输入框正在显示，积分数值已创建但暂时隐藏');
        }

        // 1秒后移除积分数值并恢复骰子（与CSS动画时间一致）
        setTimeout(() => {
            if (energyText && energyText.parentNode) {
                energyText.remove();
            }
            // 检查聊天输入框是否正在显示，如果是则不恢复骰子显示
            const chatInputArea = document.getElementById('chatInputArea');
            const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
            if (diceDisplay && !isChatInputVisible) {
                diceDisplay.style.display = 'flex';
            }
        }, 1000);
    }

    /**
     * 显示传送门图标
     */
    showTeleportIcon() {
        const diceDisplay = document.getElementById('diceDisplay');
        if (!diceDisplay) return;

        // 隐藏骰子
        diceDisplay.style.display = 'none';

        // 获取当前玩家
        const currentPlayer = gameState.getCurrentPlayer();

        // 创建传送门图标容器
        let teleportIcon = document.getElementById('teleportIcon');
        if (!teleportIcon) {
            teleportIcon = document.createElement('div');
            teleportIcon.id = 'teleportIcon';
            teleportIcon.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"
                        stroke-width="2">
                        <path d="M7.027 11.477a5 5 0 1 0 5.496-4.45a4.95 4.95 0 0 0-3.088.681">
                        </path>
                        <path d="M5.636 5.636a9 9 0 1 0 3.555-2.188"></path>
                        <path d="M17 5a1 1 0 1 0 2 0a1 1 0 1 0-2 0"></path>
                        <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0"></path>
                        <path d="M8 16a1 1 0 1 0 2 0a1 1 0 1 0-2 0"></path>
                    </g>
                </svg>
            `;
            diceDisplay.parentNode.insertBefore(teleportIcon, diceDisplay);
        }

        // 类名一致就别重写：整段重写等于摘掉再挂上脉冲动画，图标会从头跳一下
        const wantedClass = `dice-icon dice-icon-centered player-${currentPlayer}-border pulse-animation`;
        if (teleportIcon.className !== wantedClass) {
            teleportIcon.className = wantedClass;
        }

        // 检查聊天输入框是否正在显示，如果是则临时隐藏但标记应该显示
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        if (isChatInputVisible) {
            teleportIcon.style.display = 'none';
            teleportIcon.dataset.shouldShow = 'true';
            console.log('[传送门] 聊天输入框正在显示，传送门图标已创建但暂时隐藏');
        } else {
            teleportIcon.style.display = 'flex';
            console.log('[传送门] 骰子已隐藏，传送门图标已显示');
        }
    }

    /** 只收传送门图标，不动骰子与其他道具界面 */
    hideTeleportIcon() {
        const teleportIcon = document.getElementById('teleportIcon');
        if (!teleportIcon) return;
        teleportIcon.style.display = 'none';
        teleportIcon.style.animation = '';
    }

    /** 中央位置回到普通骰子：收起传送门图标与多面骰子牌，重复调用无副作用 */
    restoreDiceIcon() {
        const diceDisplay = document.getElementById('diceDisplay');

        this.hideTeleportIcon();

        // 数字牌还在展示点数时先留着，收完自己会把骰子亮回来
        const polyhedralPending = this.hidePolyhedralDice();
        const chatInputArea = document.getElementById('chatInputArea');
        const isChatInputVisible = chatInputArea && chatInputArea.style.display === 'flex';
        // 暂停期间不许把骰子亮出来，否则会盖在暂停提示上
        const paused = gameState.getIsPaused?.();
        if (diceDisplay && !isChatInputVisible && !polyhedralPending && !paused) {
            diceDisplay.style.display = 'flex';
        }
    }

    /**
     * 道具进行中状态的唯一渲染入口：只按权威字段决定该亮什么，重复调用无副作用。
     * localTurn 表示这是本机这位人类玩家自己的回合。
     */
    renderItemState(state = {}) {
        this._itemState = {
            pendingItem: state.pendingItem || null,
            diceItem: state.diceItem || false,
            diceValue: state.diceValue || 0,
            currentPlayer: state.currentPlayer ?? null,
            localTurn: Boolean(state.localTurn)
        };
        this._applyItemState();
    }

    /** 按最近一次权威字段重画（聊天框收起、暂停恢复这类纯 UI 时机） */
    refreshItemVisuals() {
        if (this._itemState) this._applyItemState();
    }

    _applyItemState() {
        const { pendingItem, diceItem, diceValue, currentPlayer, localTurn } = this._itemState;
        // 选点面板只属于本机这位玩家自己的回合；AI 的点数由服务端自己选
        const remoteDicePending = pendingItem === 'remote-dice';
        const remoteDiceSelecting = remoteDicePending && localTurn;

        // 已经选完点数的激活态别再开面板：激活快照可能晚于玩家点选到达，
        // 那时重建面板会盖住骰子，投掷动画就没人看得见了
        if (!remoteDicePending) {
            this._remoteDicePicked = false;
            this._remoteDicePickedValue = null;
        }

        // 传送门：图标全桌可见；只有负责本回合操作的那台机器进入选子态（点数用 999 占位）
        const teleportPending = pendingItem === 'teleport';
        if (window.gameInstance) {
            window.gameInstance.isTeleportMode = teleportPending && localTurn;
        }
        if (teleportPending && localTurn) {
            gameState.setGamePhase?.('selecting');
            gameState.setDiceValue?.(999);
        }

        // 中央位置四选一：传送门图标 / 遥控骰子选点面板 / 多面骰子数字牌 / 普通骰子
        if (teleportPending) {
            this.removeDiceSelectionPanel();
            this.hidePolyhedralDice();
            this.showTeleportIcon();
        } else if (remoteDicePending) {
            // 选点期间中央位置归面板，骰子由 updateDiceDisplay 按面板可见性收好
            this.hideTeleportIcon();
            this.hidePolyhedralDice();
            // 只有本机这位玩家才开面板与计时；AI 这一手由服务端完成
            if (remoteDiceSelecting) {
                if (currentPlayer !== null && !this._remoteDicePicked && !document.getElementById('diceSelectionPanel')) {
                    this.showDiceSelectionPanel(currentPlayer);
                } else if (currentPlayer !== null && !this._remoteDicePicked) {
                    // 面板已开着：服务端可能刚为这次激活开了新窗（激活会重置思考时间），
                    // 把选点计时续到新窗上，否则本地会在旧窗到点时提前走 AI 托管
                    this.armDiceSelectionTimeout(currentPlayer);
                }
                // 已选完点数、等点数落地：骰面先停在选的点上，别退回未投掷的 ⚀
                if (this._remoteDicePicked && this._remoteDicePickedValue) {
                    gameState.diceValue = this._remoteDicePickedValue;
                    const diceDisplay = document.getElementById('diceDisplay');
                    if (diceDisplay) {
                        diceDisplay.textContent = DICE_SYMBOLS[this._remoteDicePickedValue - 1];
                    }
                }
            } else {
                this.removeDiceSelectionPanel();
            }
        } else if (diceItem === 'polyhedral-dice' && diceValue > 0) {
            this.removeDiceSelectionPanel();
            this.hideTeleportIcon();
            // 牌已在滚或已亮着就不重建（重播滚轮、提前拍出数字）；刷新恢复才补一块静态的
            if (!document.getElementById('polyhedralDiceDisplay')) {
                this.showPolyhedralDice(diceValue, { instant: true });
            }
        } else {
            this.removeDiceSelectionPanel();
            this.restoreDiceIcon();
        }

        // 遥控骰子的青色骰面：道具拿在手里（还没掷）与掷出的结果都是这个色
        const diceDisplay = document.getElementById('diceDisplay');
        const remoteDiceActive = diceItem === 'remote-dice' || remoteDicePending;
        gameState.isRemoteDice = remoteDiceActive;
        if (diceDisplay) {
            diceDisplay.classList.toggle('remote-dice', remoteDiceActive);
        }

        // 暂停期间统一藏起来并登记，恢复时由 hidePauseIndicator 或下一次渲染亮回来
        if (gameState.getIsPaused?.()) {
            ['diceDisplay', 'teleportIcon', 'polyhedralDiceDisplay', 'diceSelectionPanel'].forEach((id) => {
                const element = document.getElementById(id);
                if (!element) return;
                element.dataset.hiddenByPause = 'true';
                element.style.display = 'none';
            });
        }
    }

    /** 收起遥控骰子的选点面板 */
    removeDiceSelectionPanel() {
        document.getElementById('diceSelectionPanel')?.remove();
    }

    /** 记一段道具结算演出（开盒、积分数值动画）：暂停要等它收场再落 */
    markItemSettlement(ms) {
        this._itemSettlingUntil = Math.max(this._itemSettlingUntil || 0, Date.now() + ms);
    }

    /** 道具结算演出是否还在进行 */
    isItemSettling() {
        return Date.now() < (this._itemSettlingUntil || 0);
    }

    /** 收起多面骰子数字牌；滚轮没停稳时延后收，返回 true 表示收牌已延后 */
    hidePolyhedralDice() {
        const polyhedralDice = document.getElementById('polyhedralDiceDisplay');
        if (!polyhedralDice) return false;

        const revealUntil = this._polyhedralRevealUntil;
        if (revealUntil && Date.now() < revealUntil) {
            this._polyhedralRevealUntil = 0;
            setTimeout(() => {
                // 期间又掷了一次多面骰子，收牌交给那一轮
                if (this._polyhedralRevealUntil) return;
                document.getElementById('polyhedralDiceDisplay')?.remove();
                this.restoreDiceIcon();
            }, revealUntil - Date.now() + 50);
            return true;
        }

        polyhedralDice.remove();
        return false;
    }

    /**
     * 切换面板显示/隐藏
     */
    togglePanel() {
        if (this.isPanelOpen) {
            this.closePanel();
        } else {
            this.openPanel();
        }
    }

    /**
     * 打开面板
     */
    openPanel() {
        if (!this.skillPanel) return;

        this.skillPanel.classList.add('show');
        this.isPanelOpen = true;

        // 更新积分显示和道具可用性
        this.updateEnergyDisplay();
        this.updateSkillAvailability();
    }

    /**
     * 关闭面板
     */
    closePanel() {
        if (!this.skillPanel) return;

        this.skillPanel.classList.remove('show');
        this.isPanelOpen = false;
    }

    /**
     * 道具面板看谁的积分：联机看自己、本地多人看当前回合的人、人机看自己那一席
     */
    _panelPlayer() {
        if (gameState.getIsOnlineMultiplayer()) {
            const manager = window.gameInstance && window.gameInstance.multiplayerGameManager;
            const mine = manager && manager.getPlayerNumberByPlayerId && manager.getPlayerNumberByPlayerId(manager.playerId);
            if (mine) return mine;
        } else if (!gameState.getIsLocalMultiplayer?.()) {
            const seat = window.gameInstance && window.gameInstance.localPlayerColor;
            if (seat) return seat;
        }
        return gameState.getCurrentPlayer();
    }

    /**
     * 更新积分显示
     */
    updateEnergyDisplay() {
        if (!this.skillEnergyText) return;

        const currentEnergy = energyManager.getEnergy(this._panelPlayer());
        const maxEnergy = energyManager.maxEnergy;

        this.skillEnergyText.textContent = `积分: ${Math.floor(currentEnergy)}/${maxEnergy}`;
    }

    /**
     * 更新道具可用性状态
     */
    updateSkillAvailability() {
        const currentEnergy = energyManager.getEnergy(this._panelPlayer());

        const skillItems = document.querySelectorAll('.skill-item');
        skillItems.forEach(item => {
            const skillId = item.dataset.skill;
            const cost = parseInt(item.dataset.cost);

            // 盲盒道具的特殊逻辑：积分>=40时禁用，<40且>=cost时可用
            if (skillId === 'mysteryBox') {
                if (currentEnergy >= 40) {
                    item.classList.add('disabled');
                } else if (currentEnergy >= cost) {
                    item.classList.remove('disabled');
                } else {
                    item.classList.add('disabled');
                }
            } else {
                // 其他道具：积分>=cost时可用
                if (currentEnergy >= cost) {
                    item.classList.remove('disabled');
                } else {
                    item.classList.add('disabled');
                }
            }
        });
    }

    /**
     * 显示通知消息
     * @param {string} message - 消息内容
     */
    showNotification(message) {
        // 如果有已存在的通知，先移除它
        if (this.currentNotification) {
            if (this.currentNotification.parentNode) {
                this.currentNotification.parentNode.removeChild(this.currentNotification);
            }
            if (this.notificationTimeout) {
                clearTimeout(this.notificationTimeout);
            }
            this.currentNotification = null;
            this.notificationTimeout = null;
        }

        // 积分图标 SVG
        const scoreIcon = `<svg t="1777811441484" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1702" style="height: 1.4em; width: 1.4em; vertical-align: -0.35em; fill: currentColor; margin-left: 0; display: inline-block;"><path d="M511.838 472.601c-173.757 0-358.398-56-358.398-159.679 0-103.684 184.641-159.762 358.398-159.762 173.761 0 358.402 56 358.402 159.68 0 103.679-184.64 159.761-358.402 159.761z m0-265.839c-188.718 0-304.636 61.839-304.636 106.078 0 44.242 115.918 106.16 304.636 106.16 188.722 0 304.64-61.84 304.64-106.16 0.001-44.321-115.917-106.078-304.64-106.078z m0 0" p-id="1703"></path><path d="M511.838 594.039c-172.636 0-358.398-40.56-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.358 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.12-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1704"></path><path d="M511.838 721.719c-172.636 0-358.398-40.559-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.359 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.121-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1705"></path><path d="M511.838 869.961c-172.636 0-358.398-40.563-358.398-129.68v-24.402c0-14.797 12.078-26.797 26.879-26.797 14.801 0 26.883 12 26.883 26.797v24.402c0 22.719 103.679 76.078 304.636 76.078 200.96 0 304.64-53.359 304.64-76.078v-24.402c0-14.797 12-26.797 26.883-26.797 14.797 0 26.879 12 26.879 26.797v24.402c0 89.116-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1706"></path></svg>`;

        // 创建通知元素
        const notification = document.createElement('div');
        notification.className = 'game-notification';
        notification.innerHTML = message.replace(/积分/g, scoreIcon);

        const gameContainer = document.querySelector('.game-container');
        const targetContainer = document.body;

        // 预处理：计算最优宽度以实现平衡换行，避免出现一行很长一行很短的情况
        // 将通知移出视口，避免影响页面布局
        notification.style.position = 'absolute';
        notification.style.top = '-9999px';
        notification.style.left = '-9999px';
        notification.style.visibility = 'hidden';
        notification.style.whiteSpace = 'nowrap';
        notification.style.width = 'max-content';
        notification.style.pointerEvents = 'none';
        targetContainer.appendChild(notification);

        // 测量实际单行宽度
        const fullWidth = notification.offsetWidth;
        // 获取容器的最大允许宽度 (参考CSS中的max-width: 80% 或 90%)
        const containerWidth = gameContainer ? gameContainer.clientWidth : window.innerWidth;
        const isMobile = window.innerWidth <= 480;
        const maxWidth = containerWidth * (isMobile ? 0.9 : 0.8);

        if (fullWidth > maxWidth) {
            const lines = Math.ceil(fullWidth / maxWidth);
            let balancedWidth = Math.ceil(fullWidth / (lines > 1 ? 2 : lines)) + 30; 
            balancedWidth = Math.min(balancedWidth, maxWidth);
            
            notification.style.width = balancedWidth + 'px';
        } else {
            notification.style.width = 'max-content';
        }

        // 使用 fixed 定位，以游戏棋盘中心为锚点居中，不修改 main-layout 的 transform
        notification.style.position = 'fixed';
        notification.style.top = '20px';
        if (gameContainer) {
            const rect = gameContainer.getBoundingClientRect();
            const boardCenterX = rect.left + rect.width / 2;
            notification.style.left = `${boardCenterX}px`;
        } else {
            notification.style.left = '50%';
        }
        notification.style.transform = 'translateX(-50%)';
        notification.style.whiteSpace = 'normal';
        notification.style.visibility = 'visible';
        notification.style.pointerEvents = 'none';

        this.currentNotification = notification;

        // 3秒后移除 (与CSS动画时间一致)
        this.notificationTimeout = setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
            if (this.currentNotification === notification) {
                this.currentNotification = null;
                this.notificationTimeout = null;
            }
        }, 3000);
    }

    /**
     * 获取道具管理器是否可用
     * @returns {boolean}
     */
    isEnabled() {
        return energyManager.isSkillModeEnabled();
    }
}

// 创建全局实例
export const skillManager = new SkillManager();
export default SkillManager;

