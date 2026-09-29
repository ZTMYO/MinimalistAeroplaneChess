/**
 * 各事件的演出时长：客户端「行动进度条」按它走，服务端 AI 的出手节奏也按它排。
 * 改这里的数字等于同时改两边的节奏，别再各写一份。
 */
export const STEP_MS = 190;      // 逐格走子
export const DICE_FLASH_MS = 500; // 骰子闪烁定格
export const SKIP_SHAKE_MS = 900; // 无子可动：定格 + 抖动

const EVENT_MS = {
    dice: DICE_FLASH_MS,
    skip: SKIP_SHAKE_MS,
    launch: STEP_MS,
    jump: 310,
    fly: 310,
    finish: 500,
    collide: 200,
    collision_bonus: 200,
    teleport: 400,
    reset: 500,
    mystery_box: 2100, // 开盒演出：1s 图标 + 1s 数值
};

/** 这一段事件流演完大约要多久（毫秒） */
export function eventsDuration(events) {
    let ms = 0;
    for (const event of events || []) {
        if (event.type === 'walk') {
            ms += (event.path ? event.path.length : 1) * STEP_MS;
            continue;
        }
        ms += EVENT_MS[event.type] || 0;
    }
    return ms;
}
