/**
 * 主题切换：只有 亮 / 暗 两态。
 * 取值只落在 <html data-theme> 上，配色全在 css/theme.css 里，业务代码不用关心。
 * 刷新时由各页 <head> 里的行内脚本先落属性，避免闪一下亮色。
 * 切换本身走 View Transitions 的圆形扩散，起点取按钮的点击位置。
 */
const STORAGE_KEY = 'flyingChess.theme';
const LABELS = { light: '亮色', dark: '暗色' };

function readTheme() {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
    } catch (error) {
        return 'light';
    }
}

export function applyTheme() {
    const theme = readTheme();
    document.documentElement.dataset.theme = theme;
    updateButton(theme);
    return theme;
}

export function setTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    try {
        localStorage.setItem(STORAGE_KEY, next);
    } catch (error) {
        // 存不了就只在本次会话生效
    }
    applyTheme();
}

/** 扩散起点：点击坐标换算成百分比，没传事件就退回按钮自己身上 */
function setTransitionOrigin(ev) {
    const rect = button ? button.getBoundingClientRect() : null;
    const x = ev && Number.isFinite(ev.clientX) ? ev.clientX : (rect ? rect.left + rect.width / 2 : window.innerWidth - 24);
    const y = ev && Number.isFinite(ev.clientY) ? ev.clientY : (rect ? rect.top + rect.height / 2 : window.innerHeight - 24);
    const root = document.documentElement;
    root.style.setProperty('--theme-transition-x', `${(x / window.innerWidth) * 100}%`);
    root.style.setProperty('--theme-transition-y', `${(y / window.innerHeight) * 100}%`);
}

export function toggleTheme(ev) {
    const next = readTheme() === 'dark' ? 'light' : 'dark';

    // 老浏览器没有 View Transitions，退化成直接切换
    if (typeof document.startViewTransition !== 'function') {
        setTheme(next);
        return;
    }

    setTransitionOrigin(ev);
    try {
        document.startViewTransition(() => {
            setTheme(next);
        });
    } catch (error) {
        setTheme(next);
    }
}

const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
// 亮色时显示月亮（点击转暗），暗色时显示太阳，两个图标靠 scale/rotate 互换
const MOON_ICON = `<svg class="theme-icon theme-icon-moon" ${ICON_ATTRS}><path d="M12 3h.393a7.5 7.5 0 0 0 7.92 12.446A9 9 0 1 1 12 2.992z"></path></svg>`;
const SUN_ICON = `<svg class="theme-icon theme-icon-sun" ${ICON_ATTRS}><path d="M14.828 14.828a4 4 0 1 0-5.656-5.656 4 4 0 0 0 5.656 5.656"></path><path d="M6.343 17.657l-1.414 1.414M6.343 6.343 4.929 4.929M17.657 6.343l1.414-1.414M17.657 17.657l1.414 1.414M4 12H2M12 4V2M20 12h2M12 20v2"></path></svg>`;

let button = null;

function updateButton(theme) {
    if (!button) return;
    const label = `主题：${LABELS[theme]}`;
    button.classList.toggle('is-dark', theme === 'dark');
    button.title = `${label}`;
    button.setAttribute('aria-label', label);
}

function mountButton() {
    if (button || !document.body) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.innerHTML = MOON_ICON + SUN_ICON;
    button.addEventListener('click', toggleTheme);

    const infoHeader = document.querySelector('.info-header');
    const panelSwitchBtn = document.getElementById('panelSwitchBtn');
    const footerVersion = document.querySelector('.index-footer .footer-version');
    if (infoHeader) {
        button.classList.add('theme-toggle-inline');
        if (panelSwitchBtn) {
            infoHeader.insertBefore(button, panelSwitchBtn);
        } else {
            infoHeader.appendChild(button);
        }
    } else if (footerVersion) {
        button.classList.add('theme-toggle-footer');
        footerVersion.appendChild(button);
    } else {
        document.body.appendChild(button);
    }
    updateButton(readTheme());
}

applyTheme();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountButton);
} else {
    mountButton();
}
