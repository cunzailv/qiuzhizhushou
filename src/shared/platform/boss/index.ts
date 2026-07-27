// Boss 直聘平台适配器：直接复用同目录下的 parser / action-simulator 实现，
// 保证 Boss 端行为完全不变，仅通过适配器接口对外暴露。
// 注意：本模块为 self-contained，不反向依赖 content 层。
import {
  parseJobCardsFromSearchPage,
  detectPageType,
  extractJobDescriptionFromDetail,
  parseJobDetailFromPage,
} from './parser'
import {
  activateJobCard,
  clickApplyButton,
  collectJobCards,
  fillGreetingMessage,
  getJobSpecificGreeting,
  snapshotCommunicationUi,
  getChatContacts,
  clickContact,
  hasResumeSentInChat,
  clickSendResume,
  selectAndSendResume,
  closeChatDialog,
} from './action-simulator'
export type { ChatContact } from './action-simulator'
import type { PlatformAdapter, PlatformRiskConfig } from '../types'

const riskConfig: PlatformRiskConfig = {
  id: 'boss',
  name: 'Boss直聘',
  dailyLimitMarkers: [
    '位BOSS沟通',
    '今日打招呼',
    '已达上限',
    '沟通次数已达上限',
    '今日沟通次数',
  ],
  rateLimitMarkers: ['操作太频繁', '频繁', '稍后再试', '请稍后', '重试'],
  blockMarkers: ['账号异常', '账号已被封', '检测到异常', '当前账号', '暂时无法', '被限制'],
  captchaMarkers: ['请完成安全验证', '滑动验证', '验证码', '安全验证', '校验'],
}

export const bossAdapter: PlatformAdapter = {
  id: 'boss',
  name: 'Boss直聘',
  icon: '💼',
  homeUrl: 'https://www.zhipin.com/web/geek/job-recommend',
  matchesUrl: (url) => /zhipin\.com/i.test(url),
  detectPageType,
  parseJobCardsFromSearchPage,
  parseJobDetailFromPage,
  extractJobDescriptionFromDetail,
  collectJobCards,
  activateJobCard,
  clickApplyButton,
  fillGreetingMessage,
  getJobSpecificGreeting,
  snapshotCommunicationUi,
  getRiskConfig: () => riskConfig,
}

// 聊天页专属操作（仅 Boss 平台有聊天页概念）
export {
  getChatContacts,
  clickContact,
  hasResumeSentInChat,
  clickSendResume,
  selectAndSendResume,
  closeChatDialog,
}
