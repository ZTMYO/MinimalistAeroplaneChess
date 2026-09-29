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
        const isThirdSixRisk = !this.gameState.isRemoteDice && this.gameState.consecutiveSixes >= 2;
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

        // 如果是在线多人模式，先发送动画开始消息，让所有玩家同时开始动画
        if (this.gameState.isOnlineMultiplayer && window.gameInstance && window.gameInstance.multiplayerGameManager) {
            const manager = window.gameInstance.multiplayerGameManager;

            // 遥控骰子已经选好点数，这里连同点数一起提交，由服务端校验后采纳
            const intent = { type: 'roll' };
            let localPreview = null;
            if (this.presetDiceValue !== null) {
                intent.item = 'remote-dice';
                intent.value = this.presetDiceValue;
                localPreview = this.presetDiceValue;
                console.log(`玩家${this.gameState.currentPlayer}使用遥控骰子`);
                this.presetDiceValue = null;
            }

            // 骰子点数与棋面裁决都在服务端，本地只负责表现并提交意图
            const diceDisplay = document.getElementById('diceDisplay');
            if (diceDisplay) {
                // 连续两次 6 时整段投掷动画保持红色警示（与单机一致）
                const isThirdSixRisk = this.gameState.consecutiveSixes >= 2;
                manager.stopDiceFlashing();
                if (isThirdSixRisk && !this.gameState.isHappyMode()) {
                    diceDisplay.classList.remove('dice-penalty-warning');
                    diceDisplay.classList.add('dice-third-penalty');
                }
                manager.startDiceFlashing();
                // 本机已自己播过这段动画，服务端快照回来时不应再补播一次
                manager.markLocalRollIssued();
            }
            audioManager.playRollingSound();

            // 意图必须立刻提交：本地动画只是表现，延迟提交会让玩家在动画期间刷新时丢掉这次投掷
            manager.sendIntent(intent);

            setTimeout(() => {
                manager.stopDiceFlashing();
                manager.rollStartTime = null;
                // 快照落地时回合可能已推进到下一家，必须用本次掷骰者上色
                const roller = this.gameState.currentPlayer;
                if (localPreview !== null) {
                    this.gameState.diceValue = localPreview;
                    if (this.uiUpdater?.updateDiceDisplay) {
                        this.uiUpdater.updateDiceDisplay(localPreview, roller);
                    }
                    return;
                }
                // 快照尚未落地时不写本地点数，留空让快照到达后决定骰面，
                // 避免把上一家的点数当成自己这一轮的结果显示出来
                if (this.uiUpdater?.updateDiceDisplay) {
                    this.uiUpdater.updateDiceDisplay();
                }
            }, 500); // 与动画时长保持一致
        } else {
            // 单机模式：播放音效并执行本地动画和逻辑
            audioManager.playRollingSound();

            const diceDisplay = document.getElementById('diceDisplay');

            diceDisplay.classList.remove('dice-flashing', 'dice-glowing', 'not-rolled', 'rolled');
            diceDisplay.className = 'dice-icon';
            void diceDisplay.offsetWidth; // 强制重排

            // 添加闪烁动画类
            diceDisplay.classList.add('dice-flashing');

            // 闪烁过程中随机显示不同点数
            const flashInterval = setInterval(() => {
                const randomIndex = Math.floor(Math.random() * 6);
                diceDisplay.textContent = DICE_SYMBOLS[randomIndex];
            }, 100);

            // 闪烁后停止并显示最终结果
            await new Promise(resolve => setTimeout(resolve, 500));
            clearInterval(flashInterval);
            diceDisplay.classList.remove('dice-flashing');

            // 生成最终点数：单机模式的点数只在本地产出，规则裁决交给引擎
            let diceValue;
            let rollItem = null;
            if (this.presetDiceValue !== null) {
                diceValue = this.presetDiceValue;
                this.presetDiceValue = null; // 使用后清除预设值
                // 遥控骰子必须走道具骰：不参与连投奖励与三次 6 计数，战报也记成「使用了道具」
                rollItem = 'remote-dice';
            } else {
                diceValue = Math.floor(Math.random() * 6) + 1;
                // 统计普通骰子投掷（不统计遥控骰子）
                if (this.gameState.diceStatistics && this.gameState.diceStatistics[this.gameState.currentPlayer]) {
                    this.gameState.diceStatistics[this.gameState.currentPlayer][diceValue]++;
                }
            }

            diceDisplay.textContent = DICE_SYMBOLS[diceValue - 1];

            // 只在单机模式下直接添加到游戏信息面板
            if (!rollItem) gameInfo.addDiceRoll(this.gameState.currentPlayer, diceValue);

            await this.handleEngineDice(diceValue, rollItem);
        }
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