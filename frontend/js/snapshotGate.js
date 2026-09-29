/**
 * 快照水位：按 seq 去重乱序旧帧，换会话时归零（否则新会话的快照会被旧水位全挡掉），
 * force 用于重连、回到前台这类需要确定性对齐的场景。
 */
export class SnapshotGate {
    constructor() {
        this.sessionId = null;
        this.seq = -1;
        this.forced = false;
    }

    /** 下一次到达的快照绕过水位校验（重连/回到前台对齐用） */
    forceNext() {
        this.forced = true;
    }

    reset() {
        this.sessionId = null;
        this.seq = -1;
        this.forced = false;
    }

    /**
     * 这一帧该落地吗。
     * @param {Object} snapshot - 服务端快照
     * @returns {boolean} true 表示按它投影棋面
     */
    accept(snapshot) {
        if (!snapshot) return false;

        if (snapshot.gameSessionId && snapshot.gameSessionId !== this.sessionId) {
            this.sessionId = snapshot.gameSessionId;
            this.seq = -1;
        }

        const forced = this.forced;
        this.forced = false;
        if (!forced && typeof snapshot.seq === 'number' && snapshot.seq <= this.seq) {
            return false;
        }
        if (typeof snapshot.seq === 'number') {
            this.seq = Math.max(snapshot.seq, this.seq);
        }
        return true;
    }
}
