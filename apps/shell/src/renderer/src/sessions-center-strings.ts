import type { Lang } from '@genoffice/i18n'

/** UI strings owned by the global AI Sessions Center and the panel library's cross-links. */
export interface SessionsCenterStrings {
  readonly title: string
  readonly intro: string
  readonly searchPlaceholder: string
  readonly filterAll: string
  readonly filterDocs: string
  readonly filterFree: string
  readonly filterPinned: string
  readonly filterMissing: string
  readonly sortRecent: string
  readonly sortMessages: string
  readonly refresh: string
  readonly batchToggle: string
  readonly batchCancel: string
  readonly batchSelectAll: string
  readonly batchSelectMissingOrEmpty: string
  readonly batchDelete: string
  readonly statsSummary: string
  readonly docBadgeMissing: string
  readonly msgCount: string
  readonly projectDefault: string
  readonly emptyList: string
  readonly noPreviewSelected: string
  readonly previewEmptyChat: string
  readonly openDocContinue: string
  readonly continueInPanel: string
  readonly rename: string
  readonly renameSave: string
  readonly renameCancel: string
  readonly pin: string
  readonly unpin: string
  readonly copyMarkdown: string
  readonly copiedMarkdown: string
  readonly exportMarkdown: string
  readonly deleteOne: string
  readonly confirmDeleteOne: string
  readonly confirmDeleteBatch: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly roleUser: string
  readonly roleAssistant: string
  readonly docLinkLabel: string
  readonly missingDocHint: string
  readonly freeChatLabel: string
  readonly libraryCurrentDocSection: string
  readonly libraryManageAll: string
  readonly headerNewChat: string
  readonly headerNewDocChat: string
  readonly menuWidthSection: string
  readonly widthCompact: string
  readonly widthStandard: string
  readonly widthWide: string
  readonly focusedContextDoc: string
  readonly focusedContextBrowser: string
  readonly focusedContextTab: string
  readonly focusedContextDismissTitle: string
  readonly focusedContextDetachedHint: string
  readonly focusedContextRestore: string
  readonly focusedContextBoundBadge: string
  readonly switchToDocChat: string
  readonly switchToDocChatCount: string
  readonly newDocChat: string
  readonly backgroundRunBanner: string
  readonly backgroundRunJump: string
}

const ZH_STRINGS: SessionsCenterStrings = {
  title: 'AI 会话中心',
  intro: '按文档隔离的每一段 AI 对话都在这里。搜索、预览记录、回到原文档继续对话，或批量清理与导出。',
  searchPlaceholder: '搜索会话标题、关联文档路径或对话正文…',
  filterAll: '全部',
  filterDocs: '文档会话',
  filterFree: '自由对话',
  filterPinned: '已置顶',
  filterMissing: '原文件缺失',
  sortRecent: '最近活跃',
  sortMessages: '消息最多',
  refresh: '刷新',
  batchToggle: '批量管理',
  batchCancel: '退出批量',
  batchSelectAll: '全选当前',
  batchSelectMissingOrEmpty: '选中空/断链会话',
  batchDelete: '删除选中 ({n})',
  statsSummary: '共 {total} 个会话 · 文档绑定 {docs} · 自由对话 {free}',
  docBadgeMissing: '原文件缺失',
  msgCount: '{n} 条消息',
  projectDefault: '默认工作区',
  emptyList: '没有找到匹配的会话记录',
  noPreviewSelected: '在左侧选择一个会话以查看完整对话记录与管理操作',
  previewEmptyChat: '该会话尚无消息记录。',
  openDocContinue: '打开文档并继续',
  continueInPanel: '在 AI 面板继续对话',
  rename: '重命名',
  renameSave: '保存',
  renameCancel: '取消',
  pin: '置顶',
  unpin: '取消置顶',
  copyMarkdown: '复制 Markdown',
  copiedMarkdown: '已复制',
  exportMarkdown: '导出 .md',
  deleteOne: '删除',
  confirmDeleteOne: '确定删除会话“{label}”吗？此操作不可撤销。',
  confirmDeleteBatch: '确定删除选中的 {n} 个会话吗？此操作不可撤销。',
  confirmLabel: '删除',
  cancelLabel: '取消',
  roleUser: '你',
  roleAssistant: 'AI 助手',
  docLinkLabel: '关联文档',
  missingDocHint: '原文件已移动或删除，仍可查看与导出历史记录',
  freeChatLabel: '独立自由对话（未绑定具体文档）',
  libraryCurrentDocSection: '当前文档会话',
  libraryManageAll: '管理全部会话 ↗',
  headerNewChat: '新建对话',
  headerNewDocChat: '新建当前文档对话',
  menuWidthSection: '面板宽度',
  widthCompact: '紧凑',
  widthStandard: '标准',
  widthWide: '宽屏',
  focusedContextDoc: '当前文档',
  focusedContextBrowser: '当前网页',
  focusedContextTab: '当前标签',
  focusedContextDismissTitle: '本次不附带此标签上下文',
  focusedContextDetachedHint: '已取消附带《{title}》上下文',
  focusedContextRestore: '恢复',
  focusedContextBoundBadge: '当前文档对话',
  switchToDocChat: '切到该文档对话',
  switchToDocChatCount: '切到文档对话 ({n})',
  newDocChat: '新建文档对话',
  backgroundRunBanner: '有任务正在后台运行',
  backgroundRunJump: '返回查看',
}

const ZH_TW_STRINGS: SessionsCenterStrings = {
  title: 'AI 會話中心',
  intro: '按文件隔離的每一段 AI 對話都在這裡。搜尋、預覽紀錄、回到原文件繼續對話，或批次清理與匯出。',
  searchPlaceholder: '搜尋會話標題、關聯文件路徑或對話正文…',
  filterAll: '全部',
  filterDocs: '文件會話',
  filterFree: '自由對話',
  filterPinned: '已釘選',
  filterMissing: '原檔案遺失',
  sortRecent: '最近活躍',
  sortMessages: '訊息最多',
  refresh: '重新整理',
  batchToggle: '批次管理',
  batchCancel: '結束批次',
  batchSelectAll: '全選目前',
  batchSelectMissingOrEmpty: '選取空/斷鏈會話',
  batchDelete: '刪除已選 ({n})',
  statsSummary: '共 {total} 個會話 · 文件綁定 {docs} · 自由對話 {free}',
  docBadgeMissing: '原檔案遺失',
  msgCount: '{n} 則訊息',
  projectDefault: '預設工作區',
  emptyList: '沒有找到符合條件的會話紀錄',
  noPreviewSelected: '請在左側選取一個會話以檢視完整對話紀錄與管理操作',
  previewEmptyChat: '此會話尚無訊息紀錄。',
  openDocContinue: '開啟文件並繼續',
  continueInPanel: '在 AI 面板繼續對話',
  rename: '重新命名',
  renameSave: '儲存',
  renameCancel: '取消',
  pin: '釘選',
  unpin: '取消釘選',
  copyMarkdown: '複製 Markdown',
  copiedMarkdown: '已複製',
  exportMarkdown: '匯出 .md',
  deleteOne: '刪除',
  confirmDeleteOne: '確定刪除會話「{label}」嗎？此操作無法復原。',
  confirmDeleteBatch: '確定刪除選取的 {n} 個會話嗎？此操作無法復原。',
  confirmLabel: '刪除',
  cancelLabel: '取消',
  roleUser: '你',
  roleAssistant: 'AI 助手',
  docLinkLabel: '關聯文件',
  missingDocHint: '原檔案已移動或刪除，仍可檢視與匯出歷史紀錄',
  freeChatLabel: '獨立自由對話（未綁定特定文件）',
  libraryCurrentDocSection: '目前文件會話',
  libraryManageAll: '管理全部會話 ↗',
  headerNewChat: '新增對話',
  headerNewDocChat: '新增目前文件對話',
  menuWidthSection: '面板寬度',
  widthCompact: '精簡',
  widthStandard: '標準',
  widthWide: '寬螢幕',
  focusedContextDoc: '目前文件',
  focusedContextBrowser: '目前網頁',
  focusedContextTab: '目前分頁',
  focusedContextDismissTitle: '本次不附帶此分頁內容',
  focusedContextDetachedHint: '已取消附帶《{title}》內容',
  focusedContextRestore: '恢復',
  focusedContextBoundBadge: '目前文件對話',
  switchToDocChat: '切至此文件對話',
  switchToDocChatCount: '切至文件對話 ({n})',
  newDocChat: '新增文件對話',
  backgroundRunBanner: '有任務正在背景執行',
  backgroundRunJump: '返回查看',
}

const EN_STRINGS: SessionsCenterStrings = {
  title: 'AI Sessions',
  intro: 'Every document-bound and free AI conversation in one place. Search, inspect transcripts, resume in the original document, export, or clean up in bulk.',
  searchPlaceholder: 'Search session title, document path, or message content…',
  filterAll: 'All',
  filterDocs: 'Document-bound',
  filterFree: 'Free chats',
  filterPinned: 'Pinned',
  filterMissing: 'Missing file',
  sortRecent: 'Recent activity',
  sortMessages: 'Most messages',
  refresh: 'Refresh',
  batchToggle: 'Batch select',
  batchCancel: 'Done selecting',
  batchSelectAll: 'Select all shown',
  batchSelectMissingOrEmpty: 'Select empty/missing',
  batchDelete: 'Delete selected ({n})',
  statsSummary: '{total} sessions · {docs} document-bound · {free} free',
  docBadgeMissing: 'File missing',
  msgCount: '{n} messages',
  projectDefault: 'Default workspace',
  emptyList: 'No matching AI sessions found',
  noPreviewSelected: 'Select a session on the left to inspect its transcript and actions',
  previewEmptyChat: 'This session has no messages yet.',
  openDocContinue: 'Open document & resume',
  continueInPanel: 'Continue in AI panel',
  rename: 'Rename',
  renameSave: 'Save',
  renameCancel: 'Cancel',
  pin: 'Pin',
  unpin: 'Unpin',
  copyMarkdown: 'Copy Markdown',
  copiedMarkdown: 'Copied',
  exportMarkdown: 'Export .md',
  deleteOne: 'Delete',
  confirmDeleteOne: 'Delete session "{label}"? This cannot be undone.',
  confirmDeleteBatch: 'Delete {n} selected sessions? This cannot be undone.',
  confirmLabel: 'Delete',
  cancelLabel: 'Cancel',
  roleUser: 'You',
  roleAssistant: 'AI Assistant',
  docLinkLabel: 'Linked document',
  missingDocHint: 'Original file was moved or deleted. You can still inspect or export the transcript.',
  freeChatLabel: 'Standalone conversation (not bound to a document)',
  libraryCurrentDocSection: 'Current document',
  libraryManageAll: 'Manage all sessions ↗',
  headerNewChat: 'New chat',
  headerNewDocChat: 'New chat for this document',
  menuWidthSection: 'Panel width',
  widthCompact: 'Compact',
  widthStandard: 'Standard',
  widthWide: 'Wide',
  focusedContextDoc: 'Active doc',
  focusedContextBrowser: 'Active page',
  focusedContextTab: 'Active tab',
  focusedContextDismissTitle: 'Detach active tab from this turn',
  focusedContextDetachedHint: 'Detached "{title}" context',
  focusedContextRestore: 'Restore',
  focusedContextBoundBadge: 'Doc thread',
  switchToDocChat: 'Open doc chat',
  switchToDocChatCount: 'Doc chat ({n})',
  newDocChat: 'New doc chat',
  backgroundRunBanner: 'Task running in background',
  backgroundRunJump: 'View',
}

export const SESSIONS_CENTER_STRINGS: Record<Lang, SessionsCenterStrings> = {
  zh: ZH_STRINGS,
  'zh-TW': ZH_TW_STRINGS,
  en: EN_STRINGS,
  ja: EN_STRINGS,
  ko: EN_STRINGS,
  fr: EN_STRINGS,
  de: EN_STRINGS,
  es: EN_STRINGS,
  th: EN_STRINGS,
  id: EN_STRINGS,
  ru: EN_STRINGS,
  ar: EN_STRINGS,
  pt: EN_STRINGS,
  it: EN_STRINGS,
  pl: EN_STRINGS,
  cs: EN_STRINGS,
  nl: EN_STRINGS,
  ms: EN_STRINGS,
  he: EN_STRINGS,
  hi: EN_STRINGS,
  vi: EN_STRINGS,
}
