/**
 * The tutorial behind stronghold_guide: how the game's systems work, chapter by chapter.
 *
 * Every chapter is a function of the match context guide.js builds from the data files the browser loads
 * (config.json for the current mode, chess, bonds, bands), so its numbers are this server's numbers. The rules
 * themselves were checked against the game source (sganggs/Stronghold-Protocol 0.3.1) — the code, not its config
 * comments; where the two disagree the code wins — and each chapter names where.
 *
 * Writing rules for anything an agent reads here:
 *   - state what exists in the game; name only things the data contains;
 *   - use affirmative statements;
 *   - explain mechanics, leave the choices to the player: no line-ups, no "good with", no priorities.
 */

/**
 * The emotes with a meaning, by their g.emote id (data/emotes.json, shared/constants.js EMOTE_THEMES). The game has 36;
 * the other 18 are numbered stickers.
 */
export const EMOTES = Object.freeze({
  autochess_battle_happy: '开心',
  autochess_battle_scared: '害怕',
  autochess_battle_sorry: '对不起',
  autochess_battle_thanks: '谢谢',
  autochess_battle_thinking: '思考',
  autochess_battle_nice_cooperate: '合作愉快',
  autochess_battle_slug_nice_work: '合作愉快！',
  autochess_battle_slug_thanks: '谢谢！',
  autochess_battle_slug_sorry: '对不起！',
  autochess_battle_slug_bye: '再见！',
  autochess_battle_slug_distrust: '？？？',
  autochess_battle_slug_very_soon: '很快就好！',
  autochess_battle_noproblem: '没问题！',
  autochess_battle_respect: '敬礼！',
  autochess_battle_call: '欢呼！',
  autochess_battle_playingcool: '酷！',
  autochess_battle_sad: '伤心',
  autochess_battle_dying: '快死了',
});

/**
 * Chapters, in reading order. `summary` says what a chapter covers and goes into the server's static instructions;
 * `lines(c)` receives the context built by guide.js (`tutorialContext`).
 */
export const CHAPTERS = Object.freeze([
  {
    id: 'tutorial.flow',
    title: '对局流程',
    summary: '回合数、每回合的阶段、机变回合、联防（联机）、作战时限',
    source: 'shared/constants.js PHASE, server/match/match/prep.js:170-180, server/match/match/setupVote.js, server/sim/battle/lifecycle.js:161-177, data/config.json modes',
    lines: (c) => [
      `一局共 ${c.lastRound} 回合。第 ${c.bossRound} 回合是最终攻势（对敌方领袖作战）。${c.hidden ? `达成条件时，第 ${c.hiddenRound} 回合进入隐秘核心（条件见“生命值与漏怪”）。` : ''}`,
      '开局：确认本局信息（g.infoReady）→ 选择策略（g.band，见 band_draft）。',
      ...(c.solo ? [] : ['确认本局信息时，玩家可以发起重随（room.rerollSetup）：observe 出现 reroll_vote，倒计时暂停，所有真人玩家同意后重抽本局设置，一人反对就取消。awaiting_me 为 true 时用 g.rerollVote { voteId, agree } 表态。']),
      `每回合：回合开始 → 休整期（买卖、摆放、装备，完成后 g.ready）→ 作战 → 结算。${c.spRounds.length ? `第 ${c.spRounds.join('、')} 回合在休整期之前有机变阶段（sp_draft，g.choice { idx } 选卡）。` : ''}`,
      ...(c.solo ? [] : ['联机时，作战后有队友漏怪、且有队友完美作战，就进入联防阶段：完美作战的队友（至多' + c.maxHelpers + '名）替漏怪的玩家迎击逃脱的敌人。']),
      `作战时限（秒）：${c.timeLimits}。时限到时场上剩余的敌人计为漏怪。`,
    ],
  },
  {
    id: 'tutorial.board',
    title: '坐标与朝向',
    summary: 'row 与 col 的方向、默认朝向、敌人路线、部署格',
    source: 'server/sim/dir.js:4-19, observation.js field',
    lines: () => [
      'row 0 在屏幕最下方：UP = row+1，DOWN = row−1，RIGHT = col+1，LEFT = col−1。field.map_rows 从屏幕顶部往下列出，每行“行号|地块”，字符下标即列号。',
      '干员默认朝 RIGHT，即敌人出发的一侧；攻击范围随朝向旋转。',
      '敌人沿 field.lanes 从高列号一侧走向 leak_tile，到达即漏怪。',
      '近战干员站 deploy_melee 的格子；远程干员站 deploy_ranged_only 或 deploy_melee 的格子。',
    ],
  },
  {
    id: 'tutorial.shop',
    title: '调度中心与资金',
    summary: '收入、资金结转、刷新与冻结、升级价、商品格、干员池、买卖价',
    source: 'server/match/player/round.js:16-47, server/match/player/economy.js:212-250, server/match/pool.js:4-20, server/match/gamedata.js, data/config.json economy',
    lines: (c) => [
      `每回合开始获得收入，第1回合起依次为 ${c.income}。`,
      `休整期结束时剩余资金清零${c.keepBands ? `；持有${c.keepBands}时剩余资金结转到下一回合` : ''}。`,
      `刷新花费 ${c.refreshPrice} 资金（me.refresh_price，免费次数用完前为0）。冻结（g.freeze）花费0资金：冻结的商品带到下一回合，下一回合开始时解冻；冻结后刷新会解除冻结并换上新商品。`,
      `升级调度中心（g.levelUp）的基础价依次为 ${c.upgradePrices}，最高 ${c.maxShopLevel} 级；从第2回合起每回合 −1（最低0），升级后按新等级的基础价重新计算（me.upgrade_price）。`,
      `每级的商品格：${c.shopSlots}。`,
      `商店从所有玩家共用的干员池抽取：每格按剩余份数加权，抽取等阶 ≤ 调度中心等级的干员。每名干员的份数按阶：${c.poolCopies}${c.solo ? '' : `（联机 ×${c.coopMultiplier}）`}。持有普通版占1份、精锐占${c.goldenCopies}份，出售时归还。`,
      `买价按阶：${c.prices}；出售返还 ${c.sellPrices} 资金。商店里的 price 是实际价格，catalog 里的 price 是基础价。`,
    ],
  },
  {
    id: 'tutorial.pieces',
    title: '干员、整备区与装备',
    summary: '整备区与场上人数、就绪条件、合成精锐、晋升奖励、装备',
    source: 'server/match/player/acquire.js:83-120,202-217, server/match/player/round.js:24-26, server/match/player/views.js:74, server/match/player/items.js, server/match/bondsMeta.js:8-9',
    lines: (c) => [
      `整备区（hand）${c.benchSize}格，临时整备区（temp）${c.tempSize}格，场上至多 me.deploy_cap 名干员（默认${c.deployCap}）。g.move 把干员放上场、换位置、转朝向或撤回整备区。`,
      '就绪条件：临时整备区清空、个人抉择已处理，此时 me.can_ready 为 true。',
      `同一干员凑齐${c.mergeCount}个普通版时自动合成精锐${c.mergeExceptions ? `（${c.mergeExceptions}）` : ''}，原来的装备回到整备区。`,
      `每次合成精锐获得一次晋升奖励（reward_offer）：从${c.reward.count}名“调度中心等级+${c.reward.tierOffset}阶”（至多${c.reward.maxTier}阶）的干员里免费选1名（g.reward { idx }）。奖励一直保留到领取，待领取时也可以就绪。`,
      `每名干员至多装备${c.equipPerChess}件（g.equip）。${c.itemMergeCount}件同名装备自动合成一件更强的装备。装备可以卸下（g.unequip）或销毁（g.destroy，返还${c.itemDestroyRefund}资金）。`,
      '变形同构体与带盟约的装备装在同一名干员身上时，这名干员获得那件装备的盟约。',
      'catalog 的 cost 是部署费用，trait 是特质（卡面文字）。',
    ],
  },
  {
    id: 'tutorial.bonds',
    title: '盟约与层数',
    summary: '人数计法、激活档位、层数、特质的触发时机与位置用语',
    source: 'server/match/bondsMeta.js:4-27, server/sim/content/garrisons/meta.js:14-15,40,172-185, server/sim/content/garrisons/battle.js:6-9,137-150, server/sim/Battle.js:105, server/match/match/settle.js:20',
    lines: (c) => [
      `人数按不同干员计：同一干员的普通版和精锐版算1名。${c.countModes.BOARD_AND_DECK ? `${c.countModes.BOARD_AND_DECK}计算场上和整备区的干员；` : ''}${c.countModes.BOARD_ALL_CHESS ? `${c.countModes.BOARD_ALL_CHESS}按场上全部精锐干员计，同名精锐分别计数；` : ''}其余盟约计算场上的干员。`,
      ...c.specialCounting,
      '人数达到 thresholds 的档位即激活（tier = 已达到的档位数）。盟约效果写着“受层数影响”时，层数越高效果越强。',
      '层数整局累积保留；盟约激活时按当前层数生效。',
      '特质开头的尖括号是触发时机：<获得时>、<售出时>、<刷新时>、<进入休整期时>、<休整期结束时>、<战斗开始时>、<部署时>、<战斗中>、<被击倒时>。',
      '写“使已激活的【X】层数+n”的特质在盟约X激活时加层；写“无需激活盟约”的特质随时加层。',
      '特质里的位置：“身前一格”是朝向方向的相邻格，“身后一格”是反方向的相邻格；“同一行”“同一列”包含自身；“同一行最右边”是同一行 col 最大的干员，可以是自身；“周围4格”是上下左右相邻的格子。',
      '“使自身及身前/身后一格干员的已激活盟约分别各层数+N”：两名干员各自的已激活盟约都+N，两人共有的盟约加两次。',
      '赋予其他干员特质的效果（“获得特质”）在开局部署之前完成，开局部署也会触发被赋予的<部署时>特质。',
      '战斗中的叠层在普通回合的战斗里生效，结算时计入；联防、最终攻势与隐秘核心的战斗按原有层数作战。',
    ],
  },
  {
    id: 'tutorial.battle',
    title: '作战',
    summary: '开局部署、再部署与 DP、阻挡、空中单位、伤害公式',
    source: 'server/sim/battle/lifecycle.js:22-35, server/sim/battle/deploy.js:200-250, server/sim/damage.js:193,198, server/sim/units.js:217, server/sim/battle/blocking.js:85-88, server/sim/targeting.js:91',
    lines: (c) => [
      '开战时棋盘上的干员全部免费部署：按列从左到右、同列从上到下依次入场。',
      `部署费用（cost）用于再部署：干员被击倒或撤退后，再部署时间结束且部署费用点数（DP）足够时回到场上。DP 开局${c.dp.init}点，每秒+${c.dp.perSec}，上限${c.dp.max}。`,
      '阻挡由站在地面格的干员完成，每名干员同时阻挡 block 个地面敌人。',
      '空中单位包括飞行敌人和带“近地悬浮”的 hover 敌人（沿地面路线走）。它们越过阻挡继续前进；普通攻击打到它们需要 hit_fly 为 true，部分技能自带对空。observe 的 fly 按这条规则标出。',
      '物理伤害 = 攻击力 − 防御力，至少为攻击力的5%。法术伤害 = 攻击力 × (1 − 法抗/100)，至少为攻击力的5%。真实伤害按原值结算。',
    ],
  },
  {
    id: 'tutorial.lp',
    title: '生命值与漏怪',
    summary: '扣血规则、团队生命池、隐秘核心的条件',
    source: 'server/match/match/settle.js:21-46,116, server/sim/spec.js:237-256, server/match/match/bossRounds.js:147, server/match/finalAssault.js:123-128, data/config.json',
    lines: (c) => [
      '初始生命值由所选策略决定（band_draft 的 lp）。生命值降到0时出局。',
      `普通回合每漏1只计数的敌人扣1点生命值，单回合至多扣${c.lpCap}点。${c.solo ? '' : '联防后，漏怪的玩家按联防结束时仍然逃脱的敌人扣生命值。'}`,
      '最终攻势与隐秘核心使用团队生命池（存活玩家生命值之和），漏怪按敌人的 boss_lp 扣除。',
      ...(c.hidden ? [`隐秘核心的条件：难度为 ${c.hidden.difficulties}，最终攻势获胜，最终攻势开始时存活玩家已激活盟约的层数总和大于 ${c.hidden.threshold}，团队生命大于 ${c.hidden.minLp}。`] : []),
    ],
  },
  {
    id: 'tutorial.draft',
    title: '策略',
    summary: '策略的生命值与效果、off_bonds、联机时的选择顺序',
    source: 'server/match/match/phases.js, public/js/screens/bandDraft.js, data/config.json bandDraft',
    lines: (c) => [
      '策略在开局选择，决定初始生命值（lp）和一个整局效果。band_draft.options 列出本模式可选的全部策略，stronghold_lookup 可查完整记录。',
      'off_bonds 列出该策略依赖、且本局禁用的盟约；这类策略照常可选。',
      ...(c.solo ? [] : [`联机时按随机顺序轮流选择，每个策略归先选的玩家（taken_by），每人可跳过${c.skips}次。`]),
    ],
  },
]);

/**
 * Mechanics a bond's description leaves implicit, checked against the simulation. Statements only; the numbers they
 * refer to are in the bond section's `params`.
 */
export const BOND_MECHANICS = Object.freeze({
  kazimierzShip: '每次有干员部署（开局部署和再部署都计入），卡西米尔干员攻击力 +atk_when_born；累计加成的上限是 base_max_atk_when_born + max_atk_when_born_per_stack × 层数。（server/sim/content/bonds/core.js:25）',
  egirShip: '吞噬顺序：更靠左的先吞噬，同列更靠上（row 更大）的先吞噬。每名阿戈尔吞噬其朝向身前一格的干员（物理伤害，受防御减免）；身前是阿戈尔时，沿它的朝向继续向前吞噬。被吞噬者的等阶决定加多少层。（server/sim/content/bonds/core.js:338-470）',
  raidShip: '突袭干员的再部署计为一次部署，触发“部署时”与“有干员部署时”类效果。（server/sim/battle/deploy.js:74,200-228）',
});
