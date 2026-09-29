import { gameState } from './gameState.js';
import { playerNameManager } from './playerNameManager.js';
import { eventHandler } from './eventHandler.js';
import { botController } from './botController.js';
import { skillManager } from './skillManager.js';

// 不能借 gameMain 的同名函数：它是页面入口，会把「启动一整局」的副作用也带进来
function updatePageTitle() {
    const configStr = sessionStorage.getItem('gameConfig');
    const instance = window.gameInstance;
    if (configStr && instance) {
        try {
            instance.updatePageTitle(JSON.parse(configStr));
            return;
        } catch (error) {
            console.error('更新页面标题失败:', error);
        }
    }
    document.title = '极简飞行棋';
}

class AITakeoverManager {
    constructor() {
        this.isActive = false;
        this.originalNames = {};
        // 绑定事件处理函数，确保在添加和移除监听器时使用相同的引用
        this.boundHandleOverlayClick = this.handleOverlayClick.bind(this);
    }

    /**
     * 检查当前是否为本地多人模式
     */
    isLocalMultiplayerMode() {
        try {
            const gameConfigStr = sessionStorage.getItem('gameConfig');
            if (gameConfigStr) {
                const gameConfig = JSON.parse(gameConfigStr);
                return gameConfig.mode === 'local_multiplayer';
            }
        } catch (error) {
            console.error('检查游戏模式失败:', error);
        }
        return false;
    }

    /**
     * 检查是否为多人游戏模式（包括本地和在线）
     */
    isMultiplayerMode() {
        try {
            const gameConfigStr = sessionStorage.getItem('gameConfig');
            if (gameConfigStr) {
                const gameConfig = JSON.parse(gameConfigStr);
                return gameConfig.mode === 'local_multiplayer' || gameConfig.mode === 'online_multiplayer';
            }
        } catch (error) {
            console.error('检查游戏模式失败:', error);
        }
        return false;
    }

    /**
     * 初始化AI托管按钮状态
     */
    initializeButton() {
        const toggleBtn = document.getElementById('toggleAITakeover');
        const pauseBtn = document.getElementById('pauseGame');
        const controlButtonsGrid = document.querySelector('.control-buttons-grid');
        if (!toggleBtn) return;
        // 在本地多人模式下隐藏按钮
        if (this.isLocalMultiplayerMode()) {
            // control-buttons-grid变成一行2列
            controlButtonsGrid.classList.remove('grid-2');
            controlButtonsGrid.classList.add('grid-1');
            toggleBtn.style.display = 'none';
            pauseBtn.style.display = 'none';
        } else {
            // 显示按钮
            controlButtonsGrid.classList.remove('grid-1');
            controlButtonsGrid.classList.add('grid-2');
            toggleBtn.style.display = 'inline-block';
            pauseBtn.style.display = 'inline-block';
            toggleBtn.disabled = true;
            // 更新按钮文本
            this.updateToggleButton();

        }
        // 初始化关闭AI托管按钮
        this.cancelAiTakeoverBtn = document.getElementById('cancelAiTakeoverBtn');
        this.skillBtn = document.getElementById('skillBtn');
        if (this.cancelAiTakeoverBtn) {
            this.cancelAiTakeoverBtn.addEventListener('click', () => {
                this.toggleTakeover();
            });
        }
        // 从 gameState 恢复 AI 托管状态
        this.isActive = gameState.isAITakeover;
        // 初始化时确保按钮显示正确
        this.updateControlButtons();
        this.updateToggleButton();
        // 如果之前是托管状态，需要显示遮罩等
        if (this.isActive) {
            this.showOverlay();
        }
    }

    /**
     * 开启AI托管
     */
    enableTakeover() {
        if (this.isActive) {
            return;
        }
        document.title = 'AI托管中...';
        this.isActive = true;
        gameState.setAITakeover(true);

        // 启用botController以支持AI托管
        botController.setEnabled(true);
        // 显示遮罩层
        this.showOverlay();
        // 存储并修改所有人类玩家的昵称
        this.modifyHumanPlayerNames();

        // 更新控制按钮：隐藏技能按钮，显示取消托管按钮
        this.updateControlButtons();

        // 更新按钮文本
        this.updateToggleButton();

        // 简化逻辑：不禁用用户交互，允许人类玩家在AI托管时也能操作

        // 联机模式下：确保自动开启托管（例如思考超时）也会将托管状态同步给服务器
        if (this.isMultiplayerMode() && !this.isLocalMultiplayerMode()) {
            this.syncAITakeoverState(true);
        }

        // 立即检查是否需要触发AI操作
        this.checkAndTriggerAIOperation();
    }

    /**
     * 检查并触发AI操作（开启托管时立即调用）
     */
    checkAndTriggerAIOperation() {
        const currentPlayer = gameState.getCurrentPlayer();

        // 特殊处理：如果当前处于遥控骰子点数选择阶段（面板已打开），优先由AI完成点数选择
        const diceSelectionPanel = document.getElementById('diceSelectionPanel');
        if (diceSelectionPanel) {
            (async () => {
                try {
                    const module = await import('./skillManager.js');
                    const skillManagerInstance = module?.skillManager;
                    if (skillManagerInstance && typeof skillManagerInstance.handleDiceSelection === 'function') {
                        const randomValue = Math.floor(Math.random() * 6) + 1;
                        await skillManagerInstance.handleDiceSelection(randomValue, currentPlayer, diceSelectionPanel);
                    }
                } catch (error) {
                    console.error('AI托管：处理遥控骰子自动选择时出错:', error);
                }
            })();
        }

        if (botController) {
            setTimeout(() => {
                botController.handleBotTurn();
            }, 500);
        }
    }

    /**
     * 关闭AI托管
     */
    disableTakeover() {
        if (!this.isActive) {
            return;
        }
        updatePageTitle();
        this.isActive = false;
        gameState.setAITakeover(false);

        // 隐藏遮罩层
        this.hideOverlay();

        // 恢复所有玩家的原始昵称
        this.restoreOriginalNames();

        // 更新控制按钮：显示技能按钮，隐藏取消托管按钮
        this.updateControlButtons();

        // 让skillManager重新显示技能按钮
        if (skillManager && skillManager.updateButtonVisibility) {
            skillManager.updateButtonVisibility();
        }

        // 如果当前正是自己的回合，强制恢复交互逻辑
        if (window.gameState) {
            const isOnline = window.gameState.getIsOnlineMultiplayer();
            
            let isMyTurn = false;
            if (isOnline && window.multiplayerGameManager) {
                isMyTurn = window.multiplayerGameManager.getCurrentPlayerId() === window.multiplayerGameManager.playerId;
            } else {
                // 本地模式，检查当前玩家是否为人类（非机器人）
                const currentPlayer = window.gameState.getCurrentPlayer();
                isMyTurn = !window.gameState.isBotPlayer(currentPlayer);
            }

            if (isMyTurn) {
                console.log('[AI托管] 主动关闭托管：在自己回合恢复本地交互');
                this.enableUserInteraction();
                // 托管期间这台机器是按「代打」画的：本地投掷锁可能还压着、进度条停着，
                // 只重画 UI 解不开，得按服务端那扇思考窗口续上（暂停再继续之所以能救回来就是这个原因）
                if (gameState) {
                    gameState.isRolling = false;
                }
                window.uiUpdater?.resumeThinkingProgressBar?.();
                if (window.uiUpdater) {
                    window.uiUpdater.updateUI();
                }
            }
        }

        // 更新按钮文本
        this.updateToggleButton();

        // 简化逻辑：不重新启用用户交互，因为从未禁用过
    }

    /**
     * 更新右侧控制按钮的显示/隐藏状态
     */
    updateControlButtons() {
        if (this.skillBtn && this.cancelAiTakeoverBtn) {
            if (this.isActive) {
                // AI托管中：显示取消托管按钮，隐藏技能按钮
                this.skillBtn.style.display = 'none';
                this.cancelAiTakeoverBtn.style.display = 'block';
            } else {
                // 非AI托管：隐藏取消托管按钮
                this.cancelAiTakeoverBtn.style.display = 'none';
                // 移除手动设置的display属性，让skillManager完全接管
                this.skillBtn.style.display = '';
            }
        }
    }

    /**
     * 处理来自服务器的托管状态变更（针对本地玩家自身）
     * 仅更新本地UI和状态，不触发向服务器的同步，避免死循环
     */
    applyRemoteTakeoverState(isActive) {
        if (this.isActive === isActive) {
            return;
        }

        this.isActive = isActive;
        gameState.setAITakeover(isActive);

        if (isActive) {
            document.title = 'AI托管中...';
            this.showOverlay();
            
            // 启用botController
            if (window.botController) {
                window.botController.setEnabled(true);
            }
            
            // 更新控制按钮
            this.updateControlButtons();
        } else {
            updatePageTitle();
            this.hideOverlay();
            
            // 更新控制按钮
            this.updateControlButtons();

            // 如果关闭的是本地玩家自己的托管，强制恢复交互逻辑
            if (window.multiplayerGameManager && window.gameState) {
                const currentPlayerId = window.multiplayerGameManager.getCurrentPlayerId();
                const localPlayerId = window.multiplayerGameManager.playerId;
                
                // 只要是自己的回合关闭托管，就应该恢复交互
                if (currentPlayerId === localPlayerId) {
                    console.log('[AI托管] 检测到在自己回合关闭托管，强制恢复交互');
                    // 1. 恢复交互属性
                    if (this.enableUserInteraction) {
                        this.enableUserInteraction();
                    }
                    // 2. 强制触发UI更新
                    if (window.uiUpdater) {
                        window.uiUpdater.updateUI();
                    }
                }
            }
        }

        this.updateToggleButton();
    }

    /**
     * 切换AI托管状态
     */
    toggleTakeover() {
        // 在线多人游戏模式下，AI托管功能需要同步到其他玩家
        if (this.isMultiplayerMode() && !this.isLocalMultiplayerMode()) {
            // 在线多人游戏模式，需要通过WebSocket同步AI托管状态
            this.toggleOnlineMultiplayerTakeover();
            return;
        }

        // 检查是否为本地多人模式
        if (this.isLocalMultiplayerMode()) {
            console.log('本地多人模式下无法使用AI托管功能');
            return;
        }

        if (this.isActive) {
            this.disableTakeover();
        } else {
            this.enableTakeover();
        }
    }

    /**
     * 在线多人游戏模式下切换AI托管状态
     */
    toggleOnlineMultiplayerTakeover() {
        if (this.isActive) {
            this.disableTakeover();
            // 通知其他玩家AI托管已关闭
            this.syncAITakeoverState(false);
        } else {
            // 开启托管时的联机同步由 enableTakeover 内部处理，避免重复发送
            this.enableTakeover();
        }
    }

    /**
     * 同步AI托管状态到其他玩家
     */
    syncAITakeoverState(isActive) {
        try {
            if (window.multiplayerGameManager && window.multiplayerGameManager.isConnected) {
                // 联机模式下，AI托管是“本机玩家（浏览器）”自己的状态。
                // 不能用 getCurrentPlayerId()（当前回合玩家），否则会把托管同步到错误的玩家身上。
                const playerId = window.multiplayerGameManager.playerId;

                console.log('AI托管状态同步开始:', {
                    playerId,
                    isActive,
                    isConnected: window.multiplayerGameManager.isConnected
                });

                if (!playerId) {
                    console.warn('无法同步AI托管状态：本机playerId为空');
                    return;
                }

                // 同步AI托管状态
                window.multiplayerGameManager.sendMessage('aiTakeoverChange', {
                    playerId: playerId,
                    isActive: isActive,
                    timestamp: Date.now()
                });

                // 同步昵称变化
                if (isActive) {
                    // 获取当前玩家编号和修改后的昵称
                    const playerNumber = window.multiplayerGameManager?.getPlayerNumberByPlayerId(playerId);
                    console.log('获取玩家编号:', { playerId, playerNumber });

                    if (playerNumber && this.originalNames[playerNumber]) {
                        const newName = this.originalNames[playerNumber] + '【Bot】';
                        console.log('发送昵称变化消息:', { playerId, newName });

                        window.multiplayerGameManager.sendMessage('nicknameChange', {
                            playerId: playerId,
                            nickname: newName,
                            timestamp: Date.now()
                        });
                    } else {
                        console.warn('无法获取玩家编号或原始昵称:', {
                            playerNumber,
                            originalNames: this.originalNames
                        });
                    }
                } else {
                    // 恢复原始昵称
                    const playerNumber = window.multiplayerGameManager?.getPlayerNumberByPlayerId(playerId);
                    if (playerNumber && this.originalNames[playerNumber]) {
                        console.log('恢复原始昵称:', { playerId, originalName: this.originalNames[playerNumber] });

                        window.multiplayerGameManager.sendMessage('nicknameChange', {
                            playerId: playerId,
                            nickname: this.originalNames[playerNumber],
                            timestamp: Date.now()
                        });
                    }
                }

                console.log(`AI托管状态已同步: ${isActive ? '开启' : '关闭'}`);
            } else {
                console.warn('无法同步AI托管状态:', {
                    multiplayerGameManager: !!window.multiplayerGameManager,
                    isConnected: window.multiplayerGameManager?.isConnected
                });
            }
        } catch (error) {
            console.error('同步AI托管状态失败:', error);
        }
    }

    /**
     * 修改人类玩家昵称（添加【Bot】后缀）
     */
    modifyHumanPlayerNames() {
        // 在线联机模式下，只修改当前本地玩家的昵称
        if (this.isMultiplayerMode() && !this.isLocalMultiplayerMode()) {
            const currentPlayerId = window.multiplayerGameManager?.getCurrentPlayerId();
            if (currentPlayerId) {
                const playerNumber = window.multiplayerGameManager?.getPlayerNumberByPlayerId(currentPlayerId);
                if (playerNumber) {
                    this.modifyPlayerName(playerNumber);
                }
            }
            return;
        }

        // 本地模式（单机/本地多人）下的原有逻辑
        const botPlayers = gameState.getBotPlayers();

        // 遍历所有玩家，为非电脑玩家添加【Bot】后缀
        for (let player = 1; player <= 4; player++) {
            if (!botPlayers.includes(player)) {
                this.modifyPlayerName(player);
            }
        }
    }

    /**
     * 修改单个玩家的昵称
     */
    modifyPlayerName(player) {
        // 检查是否只剩一颗未完成的棋子，如果是则不修改昵称
        if (gameState.hasOnlyOneUnfinishedChess(player)) {
            console.log(`玩家${player}只剩一颗棋子，不修改昵称`);
            return;
        }

        // 这是人类玩家，需要修改昵称
        const originalName = playerNameManager.getPlayerName(player);

        // 检查昵称是否已经包含【Bot】标记，避免重复添加
        if (originalName.includes('【Bot】')) {
            console.log(`玩家${player}的昵称已包含【Bot】标记，跳过修改: ${originalName}`);
            // 仍然需要保存原始昵称（去除【Bot】标记的版本）
            if (!this.originalNames[player]) {
                this.originalNames[player] = originalName.replace(/【Bot】/g, '');
            }
            return;
        }

        this.originalNames[player] = originalName;

        // 添加【Bot】后缀
        const newName = originalName + '【Bot】';
        // 更新UI显示
        this.updatePlayerNameDisplay(player, newName);
    }

    /**
     * 恢复原始昵称
     */
    restoreOriginalNames() {
        for (const [player, originalName] of Object.entries(this.originalNames)) {
            const playerNum = parseInt(player);
            // 仅更新DOM显示
            this.updatePlayerNameDisplay(playerNum, originalName);
        }

        // 清空存储的原始昵称
        this.originalNames = {};
    }

    /**
     * 更新玩家昵称的UI显示
     */
    updatePlayerNameDisplay(playerNumber, name) {
        // 更新所有相关的昵称显示元素（包括电脑端和手机端）
        const playerNameElements = document.querySelectorAll(`.player-${playerNumber}-info .player-name`);
        playerNameElements.forEach((element, index) => {
            element.textContent = name;
        });
        // 额外确保移动端元素也被更新（防止选择器遗漏）
        const mobileTopElement = document.querySelector(`.players-top .player-${playerNumber}-info .player-name`);
        if (mobileTopElement) {
            mobileTopElement.textContent = name;
        }

        const mobileBottomElement = document.querySelector(`.players-bottom .player-${playerNumber}-info .player-name`);
        if (mobileBottomElement) {
            mobileBottomElement.textContent = name;
        }

        // 确保桌面端元素也被更新
        const desktopElement = document.querySelector(`.players-info .player-${playerNumber}-info .player-name`);
        if (desktopElement) {
            desktopElement.textContent = name;
        }
    }

    /**
     * 更新切换按钮的文本
     */
    updateToggleButton() {
        const toggleBtn = document.getElementById('toggleAITakeover');
        if (toggleBtn) {
            const isOfficiallyStarted = gameState && gameState.getGameOfficiallyStarted();
            const isAudioLoaded = window.audioManager && window.audioManager.isLoaded;
            const isOnlineMultiplayer = gameState && gameState.getIsOnlineMultiplayer();
            // 在线多人模式需要等待音频加载完成，人机模式可以放宽限制
            const needAudioLoaded = isOnlineMultiplayer;
            
            if (!window.gameInstance || !gameState || (!isOfficiallyStarted && gameState.getGamePhase() === 'waiting') || (needAudioLoaded && !isAudioLoaded)) {
                toggleBtn.disabled = true;
                return;
            }
            toggleBtn.disabled = false;
            toggleBtn.textContent = this.isActive ? '关闭AI托管' : '开启AI托管';
        }
    }


    /**
     * 启用用户交互（骰子和棋子点击）
     */
    enableUserInteraction() {
        // 骰子的可用性由 uiUpdater 按回合/托管状态决定（.disabled 会吃掉点击），这里只收回内联样式
        const diceElement = document.getElementById('diceDisplay');
        if (diceElement) {
            diceElement.style.pointerEvents = '';
            diceElement.style.opacity = '';
        }

        document.querySelectorAll('#board-svg use[href="#chess"]').forEach(element => {
            element.style.pointerEvents = '';
            element.style.opacity = '';
        });
    }



    /**
     * 重置托管状态（游戏重置时调用）
     */
    reset() {
        // 游戏重置时不自动关闭AI托管，保持用户的选择
        // 只清空原始昵称缓存
        this.originalNames = {};

        // 如果AI托管是开启的，重新应用昵称修改
        if (this.isActive) {
            this.modifyHumanPlayerNames();
        }
    }

    /**
     * 显示AI托管遮罩层
     */
    showOverlay() {
        const overlay = document.getElementById('ai-takeover-overlay');
        if (overlay) {
            overlay.classList.add('active');

            // 添加事件监听器来阻止用户点击
            overlay.addEventListener('click', this.boundHandleOverlayClick);
            overlay.addEventListener('mousedown', this.boundHandleOverlayClick);
            overlay.addEventListener('touchstart', this.boundHandleOverlayClick, { passive: false });
        }
    }

    /**
     * 隐藏AI托管遮罩层
     */
    hideOverlay() {
        const overlay = document.getElementById('ai-takeover-overlay');
        if (overlay) {
            overlay.classList.remove('active');

            // 移除事件监听器
            overlay.removeEventListener('click', this.boundHandleOverlayClick);
            overlay.removeEventListener('mousedown', this.boundHandleOverlayClick);
            overlay.removeEventListener('touchstart', this.boundHandleOverlayClick);

            console.log('隐藏AI托管遮罩层');
        }
    }

    /**
     * 处理遮罩层点击事件
     */
    handleOverlayClick(event) {
        // 检测是否为触摸滚动事件
        if (event.type === 'touchstart') {
            // 记录初始触摸位置
            this.initialTouchY = event.touches[0].clientY;
            this.initialTouchX = event.touches[0].clientX;

            // 添加临时的touchmove和touchend监听器
            const handleTouchMove = (moveEvent) => {
                const deltaY = Math.abs(moveEvent.touches[0].clientY - this.initialTouchY);
                const deltaX = Math.abs(moveEvent.touches[0].clientX - this.initialTouchX);

                // 如果是滚动手势（垂直移动距离大于水平移动距离且超过阈值）
                if (deltaY > deltaX && deltaY > 10) {
                    // 允许滚动，不阻止事件
                    return;
                }

                // 否则阻止事件（点击或水平滑动）
                if (moveEvent.cancelable) {
                    moveEvent.preventDefault();
                }
                moveEvent.stopPropagation();
            };

            const handleTouchEnd = (endEvent) => {
                const deltaY = Math.abs(endEvent.changedTouches[0].clientY - this.initialTouchY);
                const deltaX = Math.abs(endEvent.changedTouches[0].clientX - this.initialTouchX);

                // 如果移动距离很小，认为是点击
                if (deltaY < 10 && deltaX < 10) {
                    if (endEvent.cancelable) {
                        endEvent.preventDefault();
                    }
                    endEvent.stopPropagation();
                }

                // 移除临时监听器
                event.target.removeEventListener('touchmove', handleTouchMove);
                event.target.removeEventListener('touchend', handleTouchEnd);
            };

            // 添加临时监听器
            event.target.addEventListener('touchmove', handleTouchMove, { passive: false });
            event.target.addEventListener('touchend', handleTouchEnd, { passive: false });

            return;
        }

        // 对于非触摸事件（鼠标点击），直接阻止
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return false;
    }
}

// 创建并导出实例
export const aiTakeoverManager = new AITakeoverManager();
export default AITakeoverManager;
