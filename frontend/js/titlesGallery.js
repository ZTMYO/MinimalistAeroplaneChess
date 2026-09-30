import { titleManager } from './titleManager.js';

let galleryHtml = null;

// 条件里的数量词（三回合 / 25 格 / 12 点）提亮，读起来先看见门槛
const KEYWORD_UNITS = '回合|次|格|点|颗棋子|颗|分|名|人';
const KEYWORD_PATTERN = new RegExp(
    `\\d+(?:\\.\\d+)?%?\\s*(?:${KEYWORD_UNITS})?|[一二三四五六七八九十]+\\s*(?:${KEYWORD_UNITS})`,
    'g'
);

function highlightDesc(text) {
    return String(text).replace(KEYWORD_PATTERN, (match) => `<strong class="title-keyword">${match.trim()}</strong>`);
}

function chipHtml(name, tier) {
    return `<span class="title-chip tier-${tier}">${name}</span>`;
}

function tagHtml(text) {
    return `<span class="title-mode-tag">${text}</span>`;
}

function modeTag(source) {
    if (source.happyOnly) return tagHtml('欢乐模式');
    if (source.happyDisabled) return tagHtml('欢乐模式不授予');
    return '';
}

function familyCard(family) {
    const chain = family.levels
        .map((level) => chipHtml(level.name, level.tier))
        .join('<span class="title-chain-arrow">→</span>');
    const lines = family.levels.map((level) => `<li>${highlightDesc(level.desc)}</li>`).join('');
    return `<article class="title-card">
                <div class="title-card-head">${chain}${modeTag(family)}</div>
                <ul class="title-card-list">${lines}</ul>
            </article>`;
}

function soloCard(title) {
    return `<article class="title-card">
                <div class="title-card-head">${chipHtml(title.name, title.tier)}${modeTag(title)}</div>
                <p class="title-card-desc">${highlightDesc(title.desc)}</p>
            </article>`;
}

function groupHtml(title, note, cards) {
    return `<section class="titles-group">
                <h4 class="titles-group-title">${title}<em>${note}</em></h4>
                <div class="titles-cards">${cards}</div>
            </section>`;
}

function tierRank(tier) {
    return titleManager.TIER_RANK[tier] ?? 99;
}

function topTierRank(family) {
    return tierRank(family.levels[family.levels.length - 1].tier);
}

function buildGallery() {
    if (galleryHtml) return galleryHtml;

    const families = titleManager.FAMILIES;
    // 越往下越厉害：档数多的、稀有度高的都排在后面
    const chains = families
        .filter((family) => family.levels.length > 1)
        .sort((a, b) => a.levels.length - b.levels.length || topTierRank(b) - topTierRank(a))
        .map(familyCard)
        .join('');
    const solos = families
        .filter((family) => family.levels.length === 1)
        .sort((a, b) => tierRank(b.levels[0].tier) - tierRank(a.levels[0].tier))
        .map((family) => soloCard(family.levels[0]))
        .join('');
    const settled = [...Object.values(titleManager.UNIQUE_TITLES), ...Object.values(titleManager.FINAL_TITLES)]
        .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))
        .map(soloCard)
        .join('');

    const legend = Object.keys(titleManager.TIER_RANK)
        .sort((a, b) => titleManager.TIER_RANK[a] - titleManager.TIER_RANK[b])
        .map((tier) => chipHtml(titleManager.TIER_NAMES[tier], tier))
        .join('');

    galleryHtml = `<div class="titles-legend">${legend}</div>`
        + groupHtml('进阶称号', '同一件事按数值升级，只发最高一级', chains)
        + groupHtml('单独称号', '对局中达成即得', solos)
        + groupHtml('结算称号', '收官后按全场比较定论', settled)
        + `<p class="titles-default-note">整局没有任何称号时，结算显示「${titleManager.DEFAULT_TITLE.name}」。</p>`;
    return galleryHtml;
}

function showView(root, view) {
    const toggle = root.querySelector('[data-rules-toggle]');
    const rules = root.querySelector('[data-rules-body]');
    const gallery = root.querySelector('[data-titles-gallery]');
    const title = root.querySelector('[data-rules-title]');
    if (!toggle || !rules || !gallery) return;

    const showTitles = view === 'titles';
    if (showTitles && !gallery.innerHTML) gallery.innerHTML = buildGallery();
    gallery.style.display = showTitles ? 'flex' : 'none';
    rules.style.display = showTitles ? 'none' : 'flex';
    toggle.textContent = showTitles ? '游戏规则' : '称号一览';
    if (title) title.textContent = showTitles ? '称号一览' : '游戏规则';
}

function bind(root) {
    const toggle = root.querySelector('[data-rules-toggle]');
    if (!toggle || toggle.dataset.titlesBound) return;
    toggle.dataset.titlesBound = '1';
    toggle.addEventListener('click', () => {
        const gallery = root.querySelector('[data-titles-gallery]');
        const showingTitles = Boolean(gallery && gallery.style.display === 'flex');
        showView(root, showingTitles ? 'rules' : 'titles');
    });
}

/** 页面上每块「规则 / 称号一览」区域，凭 data 属性自己绑上切换 */
export function initTitlesGalleries() {
    document.querySelectorAll('[data-titles-view]').forEach(bind);
}

/** 全部回到规则视图（从菜单重新打开规则时调用） */
export function resetTitlesViews() {
    document.querySelectorAll('[data-titles-view]').forEach((root) => showView(root, 'rules'));
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTitlesGalleries);
} else {
    initTitlesGalleries();
}
