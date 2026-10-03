import { gameState } from './gameState.js';
import { utils, DICE_SYMBOLS } from './utils.js';
import { gameInfo } from './gameInfo.js';
import { botController } from './botController.js';
import { audioManager } from './audioManager.js';
import { engineAdapter } from './engineAdapter.js';
import { enginePlayback } from './enginePlayback.js';

class Dice {
    constructor(gameState, utils, animation, uiUpdater) {
        this.gameState = gameState;
        this.utils = utils;
        this.animation = animation;
        this.uiUpdater = uiUpdater;
        this.eventHandler = null; // 将在main.js中设置
        this.presetDiceValue = null; // 遥控骰子道具设置的预设值
    }

    /**
     * 设置eventHandler引用
     */
    setEventHandler(eventHandler) {
        this.eventHandler = eventHandler;
    }


    /**
     * 掷骰子方法
     */
    async rollDice() {
        // 防抖检查：如果正在掷骰子或游戏状态不允许，直接返回
        if (this.gameState.isRolling || (this.gameState.gamePhase !== 'rolling' && this.gameState.gamePhase !== 'waiting') || this.gameState.winner) return;

        // 用户开始操作，停止思考时间计时器
        // 掷骰演出期间：进度条暂停在原处（不归零）
        this.uiUpdater.holdThinkingProgressBar?.();

        // 如果已经连续掷出2次6，这一次有可能触发第三次6的惩罚，
        // 在整个掷骰动画期间使用纯红色样式进行高亮提示（不再红白闪烁）。
        const diceDisplay = document.getElementById('diceDisplay');
        const isPresetRoll = this.presetDiceValue !== null;
        const isThirdSixRisk = !isPresetRoll && this.gameState.consecutiveSixes >= 2;
        if (diceDisplay && isThirdSixRisk && !this.gameState.isHappyMode()) {
            // 先移除预备阶段用的警告红：投掷期间换用专门的三次惩罚红，
            // 它不带那套「保留已有样式」的粘性，不会在无子可动抖动时残留
            diceDisplay.classList.remove('dice-penalty-warning');
            diceDisplay.classList.add('dice-third-penalty');
        }

        // 设置防抖标志
        this.gameState.isRolling = true;

        // 如果是游戏开始前的第一次掷骰子，切换到rolling状态
        if (this.gameState.gamePhase === 'waiting') {
            this.gameState.gamePhase = 'rolling';
        }

        const manager = (this.gameState.isOnlineMultiplayer && window.gameInstance)
            ? window.gameInstance.multiplayerGameManager
            : null;

        // 遥控骰子：点数已经定死，不播闪烁，直接把结果定格
        if (isPresetRoll) {
            const value = this.presetDiceValue;
            this.presetDiceValue = null;
            // 遥控骰子必须走道具骰：不参与连投奖励与三次 6 计数，点数也并进道具那一条战报
            this.gameState.diceValue = value;
            this.gameState.isRemoteDice = true;
            diceDisplay?.classList.add('remote-dice');
            this.uiUpdater?.updateDiceDisplay?.(value, this.gameState.currentPlayer);

            if (manager) {
                // 本机已自己播过这段演出，服务端快照回来时不应再补播一次
                manager.markLocalRollIssued();
                manager.sendIntent({ type: 'roll', item: 'remote-dice', value });
                return;
            }
            await this.handleEngineDice(value, 'remote-dice');
            return;
        }

        // 联机模式：点数与棋面裁决都在服务端，本地只负责表现并提交意图
        if (manager) {
            if (diceDisplay) {
                manager.startDiceFlashing();
                manager.markLocalRollIssued();
            }
            audioManager.playRollingSound();

            // 意图必须立刻提交：本地动画只是表现，延迟提交会让玩家在动画期间刷新时丢掉这次投掷
            manager.sendIntent({ type: 'roll' });

            setTimeout(() => {
                manager.stopDiceFlashing();
                manager.rollStartTime = null;
                // 快照尚未落地时不写本地点数，留空让快照到达后决定骰面，
                // 避免把上一家的点数当成自己这一轮的结果显示出来
                this.uiUpdater?.updateDiceDisplay?.();
            }, 500); // 与动画时长保持一致
            return;
        }

        // 单机模式：播放音效并执行本地动画和逻辑
        audioManager.playRollingSound();

        diceDisplay.classList.remove('dice-flashing', 'dice-glowing', 'not-rolled', 'rolled');
        diceDisplay.className = 'dice-icon';
        void diceDisplay.offsetWidth; // 强制重排

        // 添加闪烁动画类
        diceDisplay.classList.add('dice-flashing');

        // 闪烁过程中随机显示不同点数
        const flashInterval = setInterval(() => {
            diceDisplay.textContent = DICE_SYMBOLS[Math.floor(Math.random() * 6)];
        }, 100);

        // 闪烁后停止并显示最终结果
        await new Promise(resolve => setTimeout(resolve, 500));
        clearInterval(flashInterval);
        diceDisplay.classList.remove('dice-flashing');

        // 生成最终点数：单机模式的点数只在本地产出，规则裁决交给引擎
        const diceValue = Math.floor(Math.random() * 6) + 1;
        const stats = this.gameState.diceStatistics?.[this.gameState.currentPlayer];
        if (stats) stats[diceValue] += 1;

        diceDisplay.textContent = DICE_SYMBOLS[diceValue - 1];
        gameInfo.addDiceRoll(this.gameState.currentPlayer, diceValue);

        await this.handleEngineDice(diceValue);
    }

    /**
     * 单机模式：把点数交给引擎裁决，再按事件流回放
     * @param {number} value 点数
     * @param {string|null} item 道具骰子（遥控骰子）时为道具 id
     */
    async handleEngineDice(value, item = null) {
        // 投影之后回合可能已经交给下家（无子可动会直接换人），掷骰者要先记下来
        const roller = this.gameState.currentPlayer;
        try {
            const { events } = item
                ? engineAdapter.itemRoll(value, 6, item)
                : engineAdapter.roll(value);
            const shake = await enginePlayback.play(events);
            engineAdapter.projectTo(this.gameState);

            // 先把掷出的骰面与颜色落定（遥控骰子是青色，普通骰子是掷骰者本色），
            // 再抖：抖动本身不碰颜色，落定晚了就会被别的颜色盖掉青色
            const diceDisplay = document.getElementById('diceDisplay');
            if (diceDisplay) {
                diceDisplay.classList.toggle('remote-dice', engineAdapter.state.diceItem === 'remote-dice');
            }
            this.uiUpdater.updateDiceDisplay(value, roller);

            // 无子可动：把这个点数走不了的抖动演完，再交给下一家
            if (shake) await enginePlayback.playDiceShake(shake);
        } catch (error) {
            console.error('引擎拒绝本次掷骰:', error);
            engineAdapter.projectTo(this.gameState);
            this.gameState.isRolling = false;
            this.uiUpdater.updateUI();
            return;
        }

        const phase = engineAdapter.state.phase;
        this.gameState.canReroll = phase === 'selecting' && engineAdapter.state.dice === 6;
        this.gameState.isRolling = false;

        this.gameState.recordDiceRollForTitle(roller, value, this.gameState.isRemoteDice === true);
        this.gameState.isRemoteDice = false;


        if (phase === 'selecting') {
            this.uiUpdater.updateUI();
            this.triggerBotOperationIfNeeded();
        } else {
            this.gameState.nextPlayer(this.uiUpdater, this.handleThinkingTimeoutWrapper.bind(this), this.triggerBotOperationIfNeeded.bind(this));
            this.uiUpdater.updateUI();
        }
    }

    /**
     * 调试掷骰子方法 - 指定点数
     */

    /**
     * 处理思考时间超时的包装函数
     */
    handleThinkingTimeoutWrapper() {
        // 暂停期间不许超时接管：计时器是暂停前挂上的，到点会把回合交给 AI
        if (this.gameState.getIsPaused()) {
            console.log('游戏已暂停，忽略思考超时');
            return;
        }
        console.log(`思考超时触发 - 当前玩家: ${this.gameState.currentPlayer}`);
        gameInfo.addThinkingTimeout(this.gameState.currentPlayer);
        // 统一使用 gameState.handleThinkingTimeout() 处理超时逻辑（内部已实现开启AI托管）
        const result = this.gameState.handleThinkingTimeout();

        if (result && result.shouldUpdateUI) {
            this.uiUpdater.updateUI();
        }

        if (result && result.shouldStartNewTimer) {
            // 为新玩家启动思考时间计时器
            setTimeout(() => {
                this.uiUpdater.startThinkingProgressBar(() => {
                    console.log(`玩家${result.newPlayer}掷骰子思考时间到，开启AI托管`);
                    this.handleThinkingTimeoutWrapper();
                });
                // 检查新玩家是否为bot，如果是则触发bot操作
                this.triggerBotOperationIfNeeded();
            }, 100);
        }
    }

    /**
     * 检查当前玩家是否为bot，如果是则触发bot操作
     */
    triggerBotOperationIfNeeded() {
        if (botController) {
            const isBot = botController.isCurrentPlayerBot();

            if (isBot) {
                setTimeout(() => {
                    botController.handleBotTurn();
                }, 100);
            }
        }
    }
}

// 创建并导出骰子实例
export const dice = new Dice(gameState, utils, null, null);
export default Dice;