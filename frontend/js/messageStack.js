/**
 * 场上的提示消息：统一从 showMessage 入队渲染。
 * 短时间来了好几条就一起叠出来（后到的在下面），然后从上到下依次退场，
 * 上面退掉一条，下面的顺势浮上来。
 */
const MAX_VISIBLE = 5;
const LIVE_MS = 3000;
const LEAVE_MS = 320;
const GAP_PX = 6;

const SCORE_ICON = `<svg t="1777811441484" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1702" style="height: 1.4em; width: 1.4em; vertical-align: -0.35em; fill: currentColor; margin-left: 0; display: inline-block;"><path d="M511.838 472.601c-173.757 0-358.398-56-358.398-159.679 0-103.684 184.641-159.762 358.398-159.762 173.761 0 358.402 56 358.402 159.68 0 103.679-184.64 159.761-358.402 159.761z m0-265.839c-188.718 0-304.636 61.839-304.636 106.078 0 44.242 115.918 106.16 304.636 106.16 188.722 0 304.64-61.84 304.64-106.16 0.001-44.321-115.917-106.078-304.64-106.078z m0 0" p-id="1703"></path><path d="M511.838 594.039c-172.636 0-358.398-40.56-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.358 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.12-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1704"></path><path d="M511.838 721.719c-172.636 0-358.398-40.559-358.398-129.68 0-14.801 12.078-26.801 26.879-26.801 14.801 0 26.883 12 26.883 26.801 0 22.723 103.679 76.082 304.636 76.082 200.96 0 304.64-53.359 304.64-76.082 0-14.801 12-26.801 26.883-26.801 14.797 0 26.879 12 26.879 26.801 0 89.121-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1705"></path><path d="M511.838 869.961c-172.636 0-358.398-40.563-358.398-129.68v-24.402c0-14.797 12.078-26.797 26.879-26.797 14.801 0 26.883 12 26.883 26.797v24.402c0 22.719 103.679 76.078 304.636 76.078 200.96 0 304.64-53.359 304.64-76.078v-24.402c0-14.797 12-26.797 26.883-26.797 14.797 0 26.879 12 26.879 26.797v24.402c0 89.116-185.761 129.68-358.402 129.68z m0 0" fill="currentColor" p-id="1706"></path></svg>`;

let stack = null;

function container() {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'game-message-stack';
    document.body.appendChild(stack);
    return stack;
}

/** 对齐到棋盘中间（窄屏时退回视口中间） */
function place() {
    const box = container();
    const gameContainer = document.querySelector('.game-container');
    if (!gameContainer) {
        box.style.left = '50%';
        box.style.maxWidth = '90vw';
        return;
    }
    const rect = gameContainer.getBoundingClientRect();
    box.style.left = `${rect.left + rect.width / 2}px`;
    box.style.maxWidth = `${Math.round(rect.width * 0.9)}px`;
}

/** 退场：先把高度撑住，再收成 0，下面的消息顺势浮上来 */
function leave(element) {
    if (!element.isConnected || element.classList.contains('leaving')) return;
    element.style.height = `${element.offsetHeight}px`;
    element.classList.add('leaving');
    requestAnimationFrame(() => {
        element.style.height = '0px';
        element.style.marginBottom = '0px';
    });
    element.removeTimer = setTimeout(() => {
        if (element.classList.contains('leaving')) element.remove();
    }, LEAVE_MS);
}

function mount(html, key) {
    const element = document.createElement('div');
    element.className = 'game-notification';
    element.innerHTML = String(html).replace(/积分/g, SCORE_ICON);
    element.style.marginBottom = `${GAP_PX}px`;
    if (key) element.dataset.key = key;
    container().appendChild(element);
    requestAnimationFrame(() => element.classList.add('visible'));
    element.leaveTimer = setTimeout(() => leave(element), LIVE_MS);
}

/**
 * 弹一条提示（HTML 或纯文本都行）
 * @param {string} html
 * @param {{key?: string}} options - key：同一件事的后续消息（例如道具使用 → 道具结果）
 *   会直接改写原来那条，而不是再叠一层
 */
export function showMessage(html, { key = null } = {}) {
    place();
    const box = container();

    if (key) {
        const live = [...box.children].find((el) => el.dataset.key === key);
        if (live) {
            // 结果回来时改写原来那条，并把离开倒计时重新计起
            clearTimeout(live.leaveTimer);
            clearTimeout(live.removeTimer);
            if (live.classList.contains('leaving')) {
                live.classList.remove('leaving');
                live.style.height = '';
                live.style.marginBottom = `${GAP_PX}px`;
            }
            live.innerHTML = String(html).replace(/积分/g, SCORE_ICON);
            live.leaveTimer = setTimeout(() => leave(live), LIVE_MS);
            return;
        }
    }

    const visible = [...box.children].filter((el) => !el.classList.contains('leaving'));
    if (visible.length >= MAX_VISIBLE) leave(visible[0]);
    mount(html, key);
}

window.addEventListener('resize', () => {
    if (stack && stack.isConnected) place();
});
