import { playerIdManager } from './playerIdManager.js';

export class WebSocketClient {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000; // 1秒
        this.messageHandlers = new Map();
        this.roomCode = null;
        this.playerId = playerIdManager.getPlayerId();
        this.isHost = false;
        this.heartbeatInterval = null; // 心跳定时器
        this.heartbeatTimeout = null; // 心跳超时定时器
        this.pingInterval = 15000; // 15秒发送一次ping（缩短间隔，更快检测断线）
        this.pongTimeout = 8000; // 8秒内没收到pong就认为断开
        this.lastPongTime = Date.now(); // 上次收到pong的时间
        this.visibilityChangeHandler = null; // 页面可见性变化处理器
        this.isReconnecting = false; // 是否正在重连中
        this.pendingMessages = []; // 断线期间攒下的消息，重连成功后补发

        // 服务器地址配置 - 根据当前环境动态设置
        // 如果是https，使用wss；如果是http，使用ws
        // 生产环境使用 /ws 路径，开发环境使用 :3001 端口
        if (typeof window !== 'undefined' && window.location) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.host;

            // 如果是localhost或包含端口号，说明是开发环境，使用3001端口
            if (host.includes('localhost') || host.includes('127.0.0.1')) {
                this.serverUrl = `${protocol}//${host.replace(/:\d+/, ':3001')}`;
            } else {
                // 生产环境，使用 /ws 路径
                this.serverUrl = `${protocol}//${host}/ws`;
            }
        } else {
            // fallback
            this.serverUrl = 'ws://localhost:3001';
        }

        // 绑定方法上下文
        this.onOpen = this.onOpen.bind(this);
        this.onMessage = this.onMessage.bind(this);
        this.onClose = this.onClose.bind(this);
        this.onError = this.onError.bind(this);
    }

    /**
     * 连接到WebSocket服务器
     * @param {string} serverUrl - 服务器地址
     * @returns {Promise<boolean>} - 连接是否成功
     */
    connect(serverUrl = null) {
        return new Promise((resolve, reject) => {
            try {
                if (serverUrl) {
                    this.serverUrl = serverUrl;
                }
                this.ws = new WebSocket(this.serverUrl);

                this.ws.onopen = (event) => {
                    this.onOpen(event);
                    resolve(true);
                };

                this.ws.onmessage = this.onMessage;
                this.ws.onclose = this.onClose;
                this.ws.onerror = (event) => {
                    this.onError(event);
                    reject(new Error('WebSocket连接失败'));
                };

                // 设置连接超时
                setTimeout(() => {
                    if (!this.isConnected && this.ws) {
                        this.ws.close();
                        reject(new Error('连接超时'));
                    }
                }, 5000);

            } catch (error) {
                console.error('WebSocket连接错误:', error);
                reject(error);
            }
        });
    }

    /**
     * 断开WebSocket连接
     * @param {number} code - 关闭代码，默认1000（正常关闭）
     * @param {string} reason - 关闭原因
     */
    disconnect(code = 1000, reason = 'Client disconnect') {
        // 停止心跳
        this.stopHeartbeat();

        if (this.ws) {
            this.ws.close(code, reason);
            this.ws = null;
        }
        this.isConnected = false;
        this.roomCode = null;
        this.playerId = null;
        this.isHost = false;
    }

    /**
     * 发送消息到服务器
     * @param {string} type - 消息类型
     * @param {Object} data - 消息数据
     */
    sendMessage(type, data = {}) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const message = {
                type: type,
                data: data,
                timestamp: Date.now(),
                playerId: this.playerId, // 确保每个消息都包含playerId
                roomCode: this.roomCode
            };

            this.ws.send(JSON.stringify(message));
            return;
        }

        // 断开时不要悄悄丢掉：攒起来，重连成功后立刻补发
        this.pendingMessages.push({ type, data });
        if (this.pendingMessages.length > 20) this.pendingMessages.shift();
        console.warn('WebSocket未连接，消息已排队:', type, data);
    }

    /**
     * 注册消息处理器
     * @param {string} type - 消息类型
     * @param {Function} handler - 处理函数
     */
    onMessageType(type, handler) {
        this.messageHandlers.set(type, handler);
    }


    /**
     * 创建房间
     * @param {Object} config - 房间配置
     */
    createRoom(config = {}) {
        this.sendMessage('createRoom', config);
    }

    /**
     * 加入房间
     * @param {string} roomCode - 房间号
     */
    joinRoom(roomCode) {
        this.sendMessage('join_room', { roomCode });
    }

    /**
     * 获取公开房间列表
     */
    listRooms() {
        this.sendMessage('listRooms');
    }

    /**
     * 加入观战
     * @param {string} roomCode - 房间号
     */
    spectateRoom(roomCode) {
        this.sendMessage('spectate_room', { roomCode });
    }

    /**
     * 离开房间
     */
    leaveRoom() {
        this.sendMessage('leave_room');
    }

    /**
     * 选择颜色
     * @param {number} colorIndex - 颜色索引 (1-4)
     */
    selectColor(colorIndex) {
        this.sendMessage('select_color', { colorIndex });
    }

    /**
     * 更新昵称
     * @param {string} nickname - 新昵称
     */
    updateNickname(nickname, options = {}) {
        const { manualInput = true } = options;
        this.sendMessage('update_nickname', { nickname, manualInput });
    }

    /**
     * 更新表情
     * @param {string} emoji - 表情键值
     */
    updateEmoji(emoji) {
        this.sendMessage('update_emoji', { emoji });
    }

    /**
     * 配置棋子数量（仅房主）
     * @param {number} pieceCount - 棋子数量
     */
    configurePieceCount(pieceCount) {
        this.sendMessage('configure_piece_count', { pieceCount });
    }

    updateRoomPrivacy(isPrivate) {
        this.sendMessage('update_room_privacy', { isPrivate: !!isPrivate });
    }

    /**
     * 添加AI玩家（仅房主）
     * @param {number} colorIndex - 颜色索引
     * @param {string} difficulty - AI难度
     */
    addAIPlayer(colorIndex, difficulty) {
        this.sendMessage('add_ai_player', { colorIndex, difficulty });
    }

    /**
     * 移除AI玩家（仅房主）
     * @param {number} colorIndex - 颜色索引
     */
    removeAIPlayer(colorIndex) {
        this.sendMessage('remove_ai_player', { colorIndex });
    }

    /**
     * 更新AI玩家难度（仅房主）
     * @param {number} colorIndex - 颜色索引
     * @param {string} difficulty - AI难度
     */
    updateAIDifficulty(colorIndex, difficulty) {
        this.sendMessage('update_ai_difficulty', { colorIndex, difficulty });
    }

    /**
     * 切换准备状态
     * @param {boolean} isReady - 是否准备
     */
    toggleReady(isReady) {
        this.sendMessage('toggle_ready', { isReady });
    }

    /**
     * 开始游戏（仅房主）
     */
    startGame() {
        this.sendMessage('startGame');
    }

    // WebSocket事件处理器
    onOpen(event) {
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // 立即发送身份确认消息，确保服务器使用正确的playerId
        this.sendMessage('identify', {
            playerId: this.playerId
        });

        // 断线期间攒下的消息在这里补发
        const pending = this.pendingMessages;
        this.pendingMessages = [];
        pending.forEach((item) => this.sendMessage(item.type, item.data));

        // 连接成功后，立即发送已保存的昵称给服务器
        if (typeof playerIdManager !== 'undefined') {
            const savedNickname = playerIdManager.getSavedNickname();
            if (savedNickname) {
                // 使用 setTimeout 确保 identify 消息先发送
                setTimeout(() => {
                    this.sendMessage('update_nickname', { nickname: savedNickname });
                }, 50);
            }
        }

        // 启动心跳
        this.startHeartbeat();

        // 触发连接成功事件
        if (this.messageHandlers.has('connected')) {
            this.messageHandlers.get('connected')(event);
        }
    }

    onMessage(event) {
        try {
            const message = JSON.parse(event.data);

            // 处理心跳pong消息
            if (message.type === 'pong') {
                this.handlePong();
                return; // 不需要进一步处理
            }

            // 处理特殊的系统消息
            if (message.type === 'roomCreated') {
                this.roomCode = message.room?.code;
                this.isHost = true;
            } else if (message.type === 'roomJoined') {
                this.roomCode = message.room?.code;
                this.isHost = false;
            }

            // 调用对应的消息处理器
            if (this.messageHandlers.has(message.type)) {
                // 传递完整的消息对象，而不仅仅是data部分
                this.messageHandlers.get(message.type)(message, message);
            }

        } catch (error) {
            console.error('解析消息失败:', error);
        }
    }

    onClose(event) {
        console.log('WebSocket连接已关闭:', event.code, event.reason);
        this.isConnected = false;

        // 停止心跳
        this.stopHeartbeat();

        // 触发断开连接事件
        if (this.messageHandlers.has('disconnected')) {
            this.messageHandlers.get('disconnected')(event);
        }

        // 只有在非正常关闭且重连次数未超限时才重连
        if (event.code !== 1000 && event.code !== 1001 && this.reconnectAttempts < this.maxReconnectAttempts) {
            // 添加延迟避免立即重连
            setTimeout(() => {
                if (!this.isConnected) {
                    this.attemptReconnect();
                }
            }, 1000);
        }
    }

    onError(event) {
        console.error('WebSocket错误:', event);

        // 触发错误事件
        if (this.messageHandlers.has('error')) {
            this.messageHandlers.get('error')(event);
        }
    }

    /**
     * 尝试重连
     */
    attemptReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // 指数退避

        console.log(`${delay}ms后尝试第${this.reconnectAttempts}次重连...`);

        setTimeout(() => {
            if (!this.isConnected) {
                this.connect().catch(error => {
                    console.error('重连失败:', error);
                });
            }
        }, delay);
    }


    /**
     * 生成随机房间号
     * @returns {string} 4位字母房间号
     */
    static generateRoomCode() {
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';
        for (let i = 0; i < 4; i++) {
            result += letters.charAt(Math.floor(Math.random() * letters.length));
        }
        return result;
    }

    /**
     * 启动心跳机制
     */
    startHeartbeat() {
        // 清除已有的心跳定时器
        this.stopHeartbeat();

        // 记录初始pong时间
        this.lastPongTime = Date.now();

        // 定期发送ping消息
        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendMessage('ping', { timestamp: Date.now() });

                // 设置超时检测：如果在pongTimeout时间内没收到pong，认为连接已断开
                this.heartbeatTimeout = setTimeout(() => {
                    console.warn('心跳超时，WebSocket可能已断开');
                    // 主动关闭连接，触发重连机制
                    if (this.ws) {
                        this.ws.close(4000, 'Heartbeat timeout');
                    }
                }, this.pongTimeout);
            }
        }, this.pingInterval);

        // 启动页面可见性监听
        this.startVisibilityListener();

        console.log(`心跳机制已启动，间隔：${this.pingInterval}ms`);
    }

    /**
     * 停止心跳机制
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
        // 停止页面可见性监听
        this.stopVisibilityListener();
    }

    /**
     * 处理pong消息
     */
    handlePong() {
        // 收到pong，清除超时定时器并记录时间
        this.lastPongTime = Date.now();
        if (this.heartbeatTimeout) {
            clearTimeout(this.heartbeatTimeout);
            this.heartbeatTimeout = null;
        }
    }

    /**
     * 启动页面可见性监听（处理手机切后台场景）
     */
    startVisibilityListener() {
        if (this.visibilityChangeHandler) return; // 避免重复监听

        this.visibilityChangeHandler = () => {
            if (document.visibilityState === 'visible') {
                console.log('页面切回前台，检查连接状态...');
                this.checkConnectionOnResume();
            }
        };

        document.addEventListener('visibilitychange', this.visibilityChangeHandler);

        // 从前进/后退缓存恢复：浏览器会把旧连接掐死，但 readyState 可能还写着 OPEN，
        // 所以不查状态，直接当断线处理，交给原有重连链路重建
        window.addEventListener('pageshow', (event) => {
            if (!event.persisted) return;
            console.log('页面从缓存恢复，按断线处理并重连');
            this.isConnected = false;
            this.stopHeartbeat();
            try {
                if (this.ws) this.ws.close();
            } catch (error) {
                // ignore
            }
            this.ws = null;
            // 和"切回前台发现断线"走同一条链路
            if (this.messageHandlers.has('connectionLost')) {
                this.messageHandlers.get('connectionLost')({ reason: 'bfcache_restore' });
            }
            this.attemptReconnect();
        });

        console.log('页面可见性监听已启动');
    }

    /**
     * 停止页面可见性监听
     */
    stopVisibilityListener() {
        if (this.visibilityChangeHandler) {
            document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
            this.visibilityChangeHandler = null;
        }
    }

    /**
     * 页面切回前台时检查连接状态
     */
    checkConnectionOnResume() {
        // 检查WebSocket状态
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.log('WebSocket已断开，触发重连...');
            this.isConnected = false;
            // 触发重连事件
            if (this.messageHandlers.has('connectionLost')) {
                this.messageHandlers.get('connectionLost')({ reason: 'visibility_change' });
            }
            return;
        }

        // 检查上次pong时间，如果超过2倍心跳间隔，认为可能已断开
        const timeSinceLastPong = Date.now() - this.lastPongTime;
        if (timeSinceLastPong > this.pingInterval * 2) {
            console.log(`上次心跳响应已过去 ${timeSinceLastPong}ms，发送立即检测ping...`);

            // 发送立即检测ping
            this.sendMessage('ping', { timestamp: Date.now(), immediate: true });

            // 设置短超时检测
            const immediateTimeout = setTimeout(() => {
                console.warn('立即检测ping超时，连接可能已断开');
                if (this.ws) {
                    this.ws.close(4001, 'Immediate ping timeout');
                }
            }, 3000); // 3秒超时

            // 临时保存原始handlePong
            const originalHandlePong = this.handlePong.bind(this);
            this.handlePong = () => {
                clearTimeout(immediateTimeout);
                this.handlePong = originalHandlePong;
                originalHandlePong();
                console.log('立即检测ping成功，连接正常');
                // 触发重连成功事件，让上层同步状态
                if (this.messageHandlers.has('connectionRestored')) {
                    this.messageHandlers.get('connectionRestored')();
                }
            };
        } else {
            console.log('连接状态正常');
            // 即使连接正常，也触发状态同步
            if (this.messageHandlers.has('connectionRestored')) {
                this.messageHandlers.get('connectionRestored')();
            }
        }
    }
}
