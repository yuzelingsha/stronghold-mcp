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
 *   - tutorial.* explains mechanics and leaves the choices to the player: no line-ups, no "good with", no priorities.
 *
 * method.* is the second kind of chapter: how to decide, for any line-up. It may give an order of work and reference
 * curves, and it stays general: no named line-up, no advice tied to one band or bond. Rules alone left an agent
 * re-deriving the basics for 33 matches. Its reference numbers are the built-in AI's (server/match/bot.js LEVEL_TARGET,
 * measured with the real engine), which reads the same frames a player gets and has no economy bonus.
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
  slug_autochess_battle_nice_work: '合作愉快！',
  slug_autochess_battle_thanks: '谢谢！',
  slug_autochess_battle_sorry: '对不起！',
  slug_autochess_battle_bye: '再见！',
  slug_autochess_battle_distrust: '？？？',
  slug_autochess_battle_very_soon: '很快就好！',
  autochess_battle_noproblem: '没问题！',
  autochess_battle_respect: '敬礼！',
  autochess_battle_call: '欢呼！',
  autochess_battle_playingcool: '酷！',
  autochess_battle_sad: '伤心',
  autochess_battle_dying: '快死了',
});

/**
 * The answer to a teammate's emote, after the game's own AI teammates (server/match/botEmotes.js onHumanEmote), with
 * the 虫动 variants, 再见 and 敬礼 added. observe offers it in comms.reply_to; the agent decides whether to send it.
 */
export const EMOTE_REPLIES = Object.freeze({
  autochess_battle_thanks: 'autochess_battle_noproblem',
  slug_autochess_battle_thanks: 'autochess_battle_noproblem',
  autochess_battle_sorry: 'autochess_battle_noproblem',
  slug_autochess_battle_sorry: 'autochess_battle_noproblem',
  autochess_battle_nice_cooperate: 'autochess_battle_thanks',
  slug_autochess_battle_nice_work: 'autochess_battle_thanks',
  autochess_battle_happy: 'autochess_battle_happy',
  autochess_battle_call: 'autochess_battle_playingcool',
  autochess_battle_playingcool: 'autochess_battle_happy',
  autochess_battle_sad: 'autochess_battle_sad',
  autochess_battle_respect: 'autochess_battle_respect',
  slug_autochess_battle_bye: 'slug_autochess_battle_bye',
});

/**
 * When players speak: the moment and the emote that fits it, for the server's instructions. The moments follow the
 * game's own AI teammates (server/match/botEmotes.js), which send about one emote a round; 就绪等待 and 生命值 are added.
 */
export const EMOTE_MOMENTS = Object.freeze([
  ['队友都已就绪，你还在操作（comms.waiting_on_me）', 'slug_autochess_battle_very_soon'],
  ['你在考虑机变或策略的选择', 'autochess_battle_thinking'],
  ['你上场联防（unite.helpers 有你）', 'autochess_battle_nice_cooperate'],
  ['队友替你联防（unite.leakers 有你）', 'autochess_battle_thanks'],
  ['你这回合漏了怪', 'autochess_battle_sorry'],
  ['你这回合完美作战', 'autochess_battle_playingcool'],
  ['队伍拿下关键一战', 'autochess_battle_call'],
  ['你的生命值快耗尽', 'autochess_battle_dying'],
]);

/**
 * The built-in AI's highest bond, in layers, by round (ABYSS, 4 seats; server/match/bot.js measured with the real
 * engine). method.build quotes it and observe's checks set the seat's own top bond beside it.
 */
export const LAYER_REFERENCE = Object.freeze([[5, 8], [8, 23], [10, 36], [12, 69], [13, 85]]);

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
    summary: '整备区与场上人数、就绪条件、合成精锐、晋升奖励、装备与道具的用法',
    source: 'server/match/player/acquire.js:83-120,202-217, server/match/player/round.js:24-26, server/match/player/views.js:74, server/match/player/items.js, server/match/bondsMeta.js:8-9',
    lines: (c) => [
      `整备区（hand）${c.benchSize}格，临时整备区（temp）${c.tempSize}格，场上至多 me.deploy_cap 名干员（默认${c.deployCap}）。g.move 把干员放上场、换位置、转朝向或撤回整备区。`,
      '就绪条件：临时整备区清空、个人抉择已处理，此时 me.can_ready 为 true。',
      `同一干员凑齐${c.mergeCount}个普通版时自动合成精锐${c.mergeExceptions ? `（${c.mergeExceptions}）` : ''}，原来的装备回到整备区。`,
      `每次合成精锐获得一次晋升奖励（reward_offer）：从${c.reward.count}名“调度中心等级+${c.reward.tierOffset}阶”（至多${c.reward.maxTier}阶）的干员里免费选1名（g.reward { idx }）。奖励一直保留到领取，待领取时也可以就绪。`,
      `每名干员至多装备${c.equipPerChess}件（g.equip）。${c.itemMergeCount}件同名装备自动合成一件更强的装备。装备可以卸下（g.unequip）或销毁（g.destroy，返还${c.itemDestroyRefund}资金）。`,
      '道具买入后放在整备区，占一个格子，装上或用掉才生效。catalog 里道具的 use 是用法：g.equip 装到一名干员身上，g.art 放到场上的一个格子。',
      '写着“装备时销毁”的道具装上即生效，随后消失，装给任意一名干员都行。写着“每回合”的收益从生效的那一回合开始累计。',
      '变形同构体与带盟约的装备装在同一名干员身上时，这名干员获得那件装备的盟约。',
      'catalog 的 cost 是部署费用，trait 是特质（卡面文字）。',
    ],
  },
  {
    id: 'tutorial.bonds',
    title: '盟约与层数',
    summary: '人数计法、激活档位、层数换算成加成的公式、特质的触发时机与位置用语',
    source: 'server/match/bondsMeta.js:4-27, server/sim/content/garrisons/meta.js:14-15,40,172-185, server/sim/content/garrisons/battle.js:6-9,137-150, server/sim/Battle.js:105, server/match/match/settle.js:20',
    lines: (c) => [
      `人数按不同干员计：同一干员的普通版和精锐版算1名。${c.countModes.BOARD_AND_DECK ? `${c.countModes.BOARD_AND_DECK}计算场上和整备区的干员；` : ''}${c.countModes.BOARD_ALL_CHESS ? `${c.countModes.BOARD_ALL_CHESS}按场上全部精锐干员计，同名精锐分别计数；` : ''}其余盟约计算场上的干员。`,
      ...c.specialCounting,
      '人数达到 thresholds 的档位即激活（tier = 已达到的档位数）。盟约效果写着“受层数影响”时，层数越高效果越强。',
      '“受层数影响”的数值 = 基础值 + 每层值 × 层数，两个数在 bond.<bondId> 页的 params 里。observe 的 bonds[].effect 是当前层数下的数值，per_layer 是每多 1 层增加的量，milestone 是下一个层数里程碑：在第几层、还差几层、到时发生什么。',
      'setup.partial_pool_bonds 是本局抽中的盟约：全部盟约都在这份名单里的干员离开卡池（setup.banned_chess），带有其他盟约的成员留在卡池。这些盟约照常激活、照常叠层。',
      'setup.disabled_bonds 是本模式关闭的盟约，这些盟约整局保持未激活。',
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
    id: 'tutorial.enemies',
    title: '敌人强度',
    summary: '每回合的敌人生命、攻击、移速倍率，领袖血池与加时',
    source: 'data/config.json modes.*.enemyScale, bossHpScale, bossOvertimeAfter, data/bosses.json bloodPoint, server/match/gamedata.js baseEnemyScale, server/match/waves.js',
    lines: (c) => [
      '敌人的实际面板 = 记录里的面板 × 本回合倍率。catalog 的敌人记录是基础值；next_enemies 的 hp_now、atk_now 和 enemy_scale 是本回合实际值。',
      ...(c.scale.hp ? [`本模式的倍率，格式“回合:倍率”。生命：${c.scale.hp}。攻击：${c.scale.atk}。移速：${c.scale.speed}。`] : []),
      '领袖的血池按难度固定，倍率作用于护卫和其他敌人。',
      ...(c.boss ? [`本局领袖 ${c.boss.name} 的血池是 ${c.boss.pool}${c.solo ? '' : ' × 战斗开始时存活的玩家数（至多4名）'}。所有玩家一起削减这个血池，结算的 bossDamage 是各自造成的部分。`] : []),
      `最终攻势开打 ${c.overtimeAfter} 秒后进入加时，团队生命值每秒 −${c.overtimeDrain}。`,
    ],
  },
  {
    id: 'tutorial.sp',
    title: '机变',
    summary: '卡片种类、悬赏敌人如何加入作战、悬赏的资金',
    source: 'server/match/choices.js cardView bountyCard, server/match/match/spDraft.js addBounty, server/match/waves.js bountyPlan, server/match/match/settle.js:40-60, data/choices.json',
    lines: (c) => [
      `${c.spRounds.length ? `本模式第 ${c.spRounds.join('、')} 回合有机变阶段。` : ''}${c.solo ? '独立模拟每次3张卡选1张。' : '同盟模拟每次6张卡，玩家按顺序各选1张。'}`,
      'kind 为 item 的卡免费发放装备。kind 为 tactic 的卡作用于盟约层数、资金、刷新等；team 为 true 时全队生效。',
      'kind 为 bounty 的是悬赏：把 enemy_key 指定的敌人加入自己接下来 rounds 场作战，每场 count 只，desc 写明了场次和资金。',
      '悬赏敌人和本回合的敌人一起出场，吃本回合倍率，出现在 next_enemies 里，漏掉时同样扣生命值。卡面的 hp_now、atk_now 是抽卡当回合的实际值。',
      '击倒悬赏敌人的玩家获得 coin 资金（联防中的队友也算）；payout 为 perfect 的悬赏在完美作战时发放。资金计入下一回合的休整期。',
      '判断悬赏：比较敌人的 hp_now 与当前阵容的输出和对空能力，比较 coin 与漏掉时扣的生命值。stronghold_lookup 按 enemy_key 查技能和抗性。',
    ],
  },
  {
    id: 'tutorial.draft',
    title: '策略',
    summary: '策略的生命值与效果、off_bonds、联机时的选择顺序',
    source: 'server/match/match/phases.js, public/js/screens/bandDraft.js, data/config.json bandDraft',
    lines: (c) => [
      '策略在开局选择，决定初始生命值（lp）和一个整局效果。band_draft.options 列出本模式可选的全部策略，stronghold_lookup 可查完整记录。',
      'off_bonds 列出该策略依赖、且本模式关闭的盟约；这类策略照常可选。',
      ...(c.solo ? [] : [`联机时按随机顺序轮流选择，每个策略归先选的玩家（taken_by），每人可跳过${c.skips}次。`]),
    ],
  },
  {
    id: 'method.round',
    title: '每回合怎么做决定',
    summary: '读战报、处理 checks、把资金用完、花钱的先后、升本节奏、留对子',
    source: 'server/match/bot.js header, LEVEL_TARGET, MERGE_HIT; docs/META.md §1.5',
    lines: () => [
      '每回合都重新判断：地图、敌人、商店和盟约都在变化，阵容、坐标和购买清单来自当回合的局面。',
      '第一步，读 battle.report：leaked_by_enemy 是漏掉的敌人和数量，casualties 是倒下的干员，units 是各自的输出。说出上回合掉血的原因和本回合要改的一件事。',
      '第二步，处理 checks 的每一条：领取晋升奖励，穿戴装备，把整备区里更强的干员换上场。',
      '第三步，花钱，这是每回合最重要的决定。内置 AI 的模拟（ABYSS，4 座，每组 60 局）：每回合多 2 资金，这名玩家的总伤害 +66%，多活 0.9 回合；每回合多 4 资金，总伤害 +98%。收入几乎全部来自回合收入，所以省下的浪费就是收入，越早的资金越值钱。',
      '花钱的先后顺序：能合成精锐的最后一张，使主盟约到达下一档的成员，阵容缺的角色（阻挡、对空、治疗），能换下场上最弱干员的更高阶干员，最后把余钱全部用来刷新。',
      '场上站满后，买入价 3～5 资金，卖出价 1 资金：买来只放在整备区的单张干员是浪费。资金留给合成和刷新。内置 AI 每局刷新 12～20 次；关掉刷新，总伤害 -20%。',
      '点就绪之前把资金用到 0。',
      '升本参考（内置 AI 的节奏）：第 3–4 回合 2 级，第 5 回合 3 级，第 7 回合 4 级，第 10 回合 5 级，第 12 回合 6 级。升级价每回合 −1，临近目标回合升级最省钱。',
      '前 4 回合把场上站到 8 名，低阶干员之后可以卖掉换新。',
      '精锐的属性约 +25%，技能升到 7 级，并附带一次高一阶的免费选人。整备区优先留成对的干员，至多留 4 对。',
      '休整期结束时资金清零：买完升完的余钱用来刷新找最后一张。资金差一点时用冻结把它留到下一回合。',
    ],
  },
  {
    id: 'method.build',
    title: '怎么定盟约路线',
    summary: '选策略看 lp、路线的三个部分、选主盟约的依据、叠层的节奏、评价干员、装备分配',
    source: 'server/match/bot.js bondPlan, itemTarget; server/match/bondsMeta.js; server/match/player/acquire.js:61',
    lines: (c) => [
      `选策略先看 lp：单回合至多扣 ${c.lpCap} 点生命值，lp 决定能承受几个失守的回合，活到最终攻势才能打领袖。模拟里 lp 45 比 lp 28 多活 1.1 回合，总伤害 +22%。可选的策略里优先选 lp 高的，再看效果。`,
      '一条盟约路线有三部分：凑够人数的成员，持续加层的叠层手，随层数变强的输出。bond.<bondId> 页列出这三类干员。',
      '第 3–5 回合定下一个主盟约和一个副盟约。依据：已有的成员数，当前等级商店能出的成员数，已积累的层数，setup.banned_chess 离开卡池的干员。partial_pool 的盟约成员变少，照常激活，同样可选。定下后连续投入。',
      '盟约到达 thresholds 第一档才生效，层数在激活时才起作用。先保证激活，再堆层数。',
      '<获得时> 特质每次买入都触发，卖出再买会再次触发，代价是买价与卖价的差。<进入休整期时>、<休整期结束时>、<刷新时> 的特质在干员留在场上时持续产层。',
      '通用叠层手作用于“当前激活且层数最多”的盟约时，主盟约要先成为层数最多的那个。',
      `层数参考（内置 AI 的最高盟约）：${LAYER_REFERENCE.map(([round, layers]) => `第 ${round} 回合 ${layers} 层`).join('，')}。`,
      '评价一名干员看它在盟约里的作用：凑人数（让盟约激活或升档）、叠层（特质写着“层数+n”）、吃层（随层数变强的输出）。catalog 的 hp、atk 是基础面板，盟约加成另算，observe 的 bonds[].effect 写出每条盟约当前的加成。',
      '场上的位置留给主盟约成员、叠层干员和吃层的输出。checks 列出所属盟约都未激活、在场时加层为 0 的场上干员，买到更合适的干员时换下它们。',
      '输出装备给主力输出，生存装备给主力阻挡，盟约装备给该盟约的成员。合成精锐时装备回到整备区，要重新穿戴。',
    ],
  },
  {
    id: 'method.place',
    title: '怎么站位',
    summary: '用 field.lanes、range_tiles 和朝向规划站位',
    source: 'server/match/bot.js planLayout, fieldModel, placeClass; docs/META.md §1.5',
    lines: () => [
      '站位按本局地图规划：field.lanes 的 tiles 是地面敌人走过的格子，从出发点排到 leak_tile，多条路线共有的格子所有地面敌人都会经过。',
      '阻挡干员站在路线的格子上，block 是同时挡住的敌人数。阻挡位靠近 leak_tile 时，敌人走完全程才被挡住，输出的时间最长。',
      '远程干员选择 range_tiles 覆盖路线格子最多的格子和朝向。放好后读 range_tiles 核对，checks 会列出覆盖为0的干员。',
      '输出集中覆盖阻挡位和它前面的路线：敌人被挡住时承受的伤害最多。治疗干员的范围覆盖阻挡干员。',
      '空中敌人越过阻挡，看 next_enemies 的 fly，用 hit_fly 为 true 的干员覆盖 leak_tile 附近。',
      '根据 next_enemies 的 gate、at_s 和 hp_now 判断压力来自哪条路线、哪个时段。',
    ],
  },
  {
    id: 'method.review',
    title: '怎么复盘',
    summary: '回合内的归因、结算后用 stronghold_review 写结论',
    source: 'mcp/review.js',
    lines: () => [
      '回合内归因：掉血时从总输出、范围覆盖、对空、阻挡四方面找原因，对照 battle.report 和 hp_now 找证据。',
      '结算后调用 stronghold_review：turning_points 是掉血最多的回合，findings 是和参考曲线的差距，seats 是全队的结算。',
      '结论写成三条以内，每条包含回合、当时的决定、下一局换成的做法。下一局开始时读上一局的结论，结束时判断它是否奏效。',
      '评价一局看证据：结算的 victory、rounds_passed、bossDamage 和 stronghold_review 的数字。',
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
