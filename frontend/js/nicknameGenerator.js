export class NicknameGenerator {
    constructor() {
        this.surnames = [
            '凌', '凯', '墨', '辰', '屿', '寻', '朔', '烬',
            '疏', '妄', '辞', '叙', '衍', '执', '越', '栖',
            '祁', '晏', '璟', '澈', '珩', '灼', '溯', '梵',
            '琛', '飒', '弈', '凛', '梧', '旬', '辙', '胤',
            '桢', '铎', '铉', '铮', '泠', '沅', '沣', '星',
            '云', '风', '夜', '时', '澜', '苍', '屿', '川',
            '遥', '野', '扬', '洛', '归', '赴', '辞', '暮',
            '朝', '景', '书', '珩', '昭', '亦', '之', '向',
            '凌一', '柒夜', '九序', '廿寻', '叁禾', '陆离', '捌玥', '千浔',
            '凌柒', '壹辰', '叁屿', '伍寻', '柒朔', '捌晏', '玖珩', '贰辞',
            '千屿', '万寻', '星辞', '月叙', '风朔', '云烬', '雾疏', '霜妄',
            '云澜', '风屿', '夜辰', '时寻', '苍朔', '澜烬', '暮辞', '朝叙'
        ];

        this.coreNames = [
            '辰', '屿', '寻', '安', '野', '川', '念', '禾',
            '星', '泽', '然', '笙', '遥', '舟', '晚', '叙',
            '辞', '妄', '执', '疏', '朔', '烬', '栖', '宁',
            '苏', '瑶', '瑾', '芮', '嘉', '沐', '宸', '妤',
            '珩', '玥', '彬', '轩', '瀚', '霖', '彤', '菲',
            '萱', '航', '诺', '悠', '冉', '恬', '逸', '洛',
            '晗', '熙', '风', '云', '夜', '时', '扬', '策',
            '澜', '苍', '归', '赴', '暮', '朝', '景', '书',
            '昭', '亦', '之', '向', '珩', '屿', '寻', '泽',
            '安', '诺', '辰', '熙', '瑶', '瑾', '沐', '轩',
            '星泽', '辰屿', '云遥', '夜寻', '风衍', '洛川', '屿安', '朔野',
            '瑾禾', '沐宸', '熙宁', '芮瑶', '诺航', '逸轩', '菲然', '彤晚',
            '苍泽', '澜辰', '暮寻', '朝屿', '书遥', '昭川', '亦安', '之野',
            '珩禾', '玥宸', '彬宁', '瀚瑶', '霖瑾', '菲沐', '萱轩', '航熙',
            '悠然', '嘉豪', '恬辰', '逸屿', '洛寻', '晗遥', '熙川', '风安',
            '云野', '夜禾', '时宸', '扬宁', '策瑶', '归瑾', '赴沐', '景轩'
        ];
    }

    generate() {
        const maxLength = 4;
        const maxAttempts = 50;

        for (let i = 0; i < maxAttempts; i++) {
            const surname = this.surnames[Math.floor(Math.random() * this.surnames.length)];
            if (!surname || surname.length > maxLength) continue;

            let nickname = surname;
            const core1 = this.coreNames[Math.floor(Math.random() * this.coreNames.length)];
            if (core1 && nickname.length + core1.length <= maxLength) {
                nickname += core1;
            } else {
                continue;
            }

            if (nickname.length < maxLength && Math.random() < 0.35) {
                const core2 = this.coreNames[Math.floor(Math.random() * this.coreNames.length)];
                if (core2 && nickname.length + core2.length <= maxLength) {
                    nickname += core2;
                }
            }

            if (this.validateLength(nickname, maxLength)) {
                return nickname;
            }
        }

        // 兜底：保证不超过4字
        const fallbackSurname = (this.surnames.find(s => s && s.length <= maxLength) || '凌');
        const remaining = maxLength - fallbackSurname.length;
        const fallbackCore = this.coreNames.find(n => n && n.length <= remaining) || '';
        return `${fallbackSurname}${fallbackCore}`;
    }

    validateLength(nickname, maxLength = 4) {
        return nickname.length <= maxLength;
    }
}

// 导出单例
export const nicknameGenerator = new NicknameGenerator();
