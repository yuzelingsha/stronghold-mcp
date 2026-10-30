/**
 * The server's MCP `instructions`: what a client puts into the agent's system prompt, ahead of the match.
 *
 * Prompt caching keys on an identical prefix, so this text is a constant of the code: it is built once from constants
 * (the tutorial chapters' ids, titles and summaries) and holds nothing of the environment, the session or the match.
 * Everything that changes reaches the agent through tool results, appended at the end of the conversation.
 * test/prompt.test.mjs checks that two servers in different states hand out the same bytes.
 *
 * It follows the guide's writing rules (guide-notes.js): things in the game, affirmative statements, no play advice.
 */
import { CHAPTERS } from './guide-notes.js';

export const INSTRUCTIONS = [
  '卫戍协议：盟约Ⅱ 的玩家会话。游戏服务器校验每个动作，标准与浏览器玩家相同。',
  '',
  '回合循环',
  '1. stronghold_observe 读局面。记下返回的 rev，下次传 since=rev：返回内容只含变化的部分，unchanged 列出与上次相同的段落。',
  '2. 需要规则或参考时，用 stronghold_guide 按 id 读取攻略段落（目录见下）。',
  '3. stronghold_action 发动作，字段见 stronghold_protocol。等待阶段推进或作战结果用 stronghold_wait_event。',
  '',
  '上下文与缓存',
  '- 本说明与全部工具定义在每个会话里逐字相同。对局信息全部来自工具结果，按时间顺序追加在对话末尾。',
  '- 攻略按需读取：一个段落读一次，之后在对话里引用它。',
  '- 对话经过压缩或摘要后，observe 省略 since 取一次完整局面（返回 resync:true 时同样是完整局面），需要的攻略段落按 id 重新读取。',
  '',
  '攻略目录（stronghold_guide 的 ids）',
  '教程，数字取自本服务器当前模式：',
  ...CHAPTERS.map((ch) => `- ${ch.id} ${ch.title}：${ch.summary}`),
  '参考页，按本局数据生成：',
  '- bonds.overview 本局盟约一览：名称、核心盟约、人数档位、计数方式',
  '- bond.<bondId> 单个盟约：档位、说明、params、给它叠层的干员、随它变强的干员（bondId 即 observe 的 bonds[].id）',
  '- bonds.generic 给任意已激活盟约加层的干员',
  '- band.<bandId> 单个策略：初始生命值与整局效果（bandId 即 band_draft.options[].id）',
  '只传 topic 时返回目录：auto 列出当前阶段相关的段落，tutorial、bonds、bands 列出整个分类；已读的段落标 read:true。',
].join('\n');
