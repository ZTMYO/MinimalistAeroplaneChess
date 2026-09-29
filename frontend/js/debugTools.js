/**
 * 调试工具：指定骰子点数、挪棋子、改积分。
 * 单机交给本地引擎；联机发 debug 意图，由服务端裁决后广播快照。
 */
import { gameState } from './gameState.js';
import { engineAdapter } from './engineAdapter.js';
import { enginePlayback } from './enginePlayback.js';
import { energyManager } from './energyManager.js';
import { uiUpdater } from './uiUpdater.js';
import { animation } from './animation.js';

function sendDebugIntent(payload) {
    const manager = window.gameInstance?.multiplayerGameManager;
    if (!manager || typeof manager.sendIntent !== 'function') return false;
    manager.sendIntent({ type: 'debug', ...payload });
    return true;
}

/** 指定本次投掷的点数 */
export async function debugSetDice(value) {
    if (gameState.getIsOnlineMultiplayer()) {
        sendDebugIntent({ op: 'dice', value });
        return;
    }
    try {
        gameState.isRolling = true;
        const { events } = engineAdapter.roll(value);
        const shake = await enginePlayback.play(events);
        engineAdapter.projectTo(gameState);
        gameState.isRolling = false;
        if (shake) await enginePlayback.playDiceShake(shake);
        uiUpdater.updateUI();
    } catch (error) {
        console.error('调试掷骰失败:', error);
        engineAdapter.projectTo(gameState);
        gameState.isRolling = false;
        uiUpdater.updateUI();
    }
}

/** 把某颗棋子前后挪几格（不判规则，仅供摆局面） */
export function debugMoveChess(player, chessIndex, delta) {
    if (gameState.getIsOnlineMultiplayer()) {
        sendDebugIntent({ op: 'move', player, chessIndex, delta });
        return;
    }
    try {
        engineAdapter.debugMove(player, chessIndex, delta);
        engineAdapter.projectTo(gameState);
        // 棋面归引擎了，位置得由动画层按新坐标重画一次
        animation.updateChessPosition(player, chessIndex, null, true);
        uiUpdater.updateUI();
    } catch (error) {
        console.error('调试挪棋子失败:', error);
    }
}

/** 把当前玩家的棋子全部送到终点（摆终局用） */
export function debugFinishChess() {
    if (gameState.getIsOnlineMultiplayer()) {
        sendDebugIntent({ op: 'finish' });
        return;
    }
    try {
        const { events } = engineAdapter.debugFinish();
        enginePlayback.play(events);
        engineAdapter.projectTo(gameState);
        uiUpdater.updateUI();
    } catch (error) {
        console.error('调试完成棋子失败:', error);
    }
}

/** 直接设定某位玩家的积分 */
export function debugSetEnergy(player, amount) {
    if (gameState.getIsOnlineMultiplayer()) {
        sendDebugIntent({ op: 'energy', player, value: amount });
        return;
    }
    try {
        engineAdapter.debugSetEnergy(player, amount);
        energyManager.applySnapshot(engineAdapter.state.energy);
        uiUpdater.updateUI();
    } catch (error) {
        console.error('调试改积分失败:', error);
    }
}
