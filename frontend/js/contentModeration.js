let bannedWordRegexes = [];
let loadPromise = null;

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskText(input) {
    if (input == null) return '';
    let text = String(input);
    if (!text || bannedWordRegexes.length === 0) return text;

    for (const regex of bannedWordRegexes) {
        text = text.replace(regex, (match) => '*'.repeat(match.length));
    }
    return text;
}

async function loadBannedWords() {
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            const dictUrl = new URL('../assets/违规词库.txt', import.meta.url);
            // Restrict to same-origin and disallow redirects so the dictionary
            // can't be transparently swapped for attacker-controlled content.
            const response = await fetch(dictUrl, {
                mode: 'same-origin',
                redirect: 'error',
                cache: 'no-store',
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const raw = await response.text();
            const MAX_WORDS = 5000;
            const words = Array.from(
                new Set(
                    raw
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean)
                )
            )
                .slice(0, MAX_WORDS)
                .sort((a, b) => b.length - a.length);

            bannedWordRegexes = words.map((word) => new RegExp(escapeRegex(word), 'gi'));
        } catch (error) {
            console.warn('[内容过滤] 违规词库加载失败，将跳过前端过滤:', error);
            bannedWordRegexes = [];
        }
    })();

    return loadPromise;
}

export async function sanitizeUserText(text) {
    await loadBannedWords();
    return maskText(text);
}


