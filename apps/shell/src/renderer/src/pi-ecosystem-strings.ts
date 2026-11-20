import type { Lang } from '@genoffice/i18n'

/** Localized strings for the Memory & Pi Ecosystem settings pane and status chips. */
export interface PiEcosystemStrings {
  readonly title: string
  readonly subtitle: string
  readonly loading: string
  readonly reloadBtn: string
  readonly refreshBtn: string
  readonly envOverrideBanner: string
  readonly secRuntimeTitle: string
  readonly engineLabel: string
  readonly engineDesc: string
  readonly enginePi: string
  readonly engineLegacy: string
  readonly mcEnabledLabel: string
  readonly mcEnabledDesc: string
  readonly storageModeLabel: string
  readonly storageModeDesc: string
  readonly storageIsolated: string
  readonly storageShared: string
  readonly embeddingLabel: string
  readonly embeddingDesc: string
  readonly embeddingOff: string
  readonly embeddingLocal: string
  readonly dreamerLabel: string
  readonly dreamerDesc: string
  readonly historianModelLabel: string
  readonly historianModelDesc: string
  readonly dreamerModelLabel: string
  readonly dreamerModelDesc: string
  readonly modelPlaceholder: string
  readonly saveModelBtn: string
  readonly readToolsLabel: string
  readonly readToolsDesc: string
  readonly writeToolsLabel: string
  readonly writeToolsDesc: string
  readonly temporalLabel: string
  readonly temporalDesc: string
  readonly autoHintsLabel: string
  readonly autoHintsDesc: string
  readonly secSystemPromptTitle: string
  readonly systemPromptDesc: string
  readonly systemPromptBadgeDefault: string
  readonly systemPromptBadgeCustom: string
  readonly systemPromptPlaceholder: string
  readonly savePromptBtn: string
  readonly resetPromptBtn: string
  readonly promptSavedMsg: string
  readonly promptResetMsg: string
  readonly secPackagesTitle: string
  readonly packagesDesc: string
  readonly packagePlaceholder: string
  readonly installBtn: string
  readonly updateAllBtn: string
  readonly updateBtn: string
  readonly removeBtn: string
  readonly removePackageConfirm: string
  readonly packagesEmpty: string
  readonly packageFilteredTag: string
  readonly secInventoryTitle: string
  readonly tabExtensions: string
  readonly tabSkills: string
  readonly tabCommands: string
  readonly inventoryEmpty: string
  readonly extensionErrorsTitle: string
  readonly toolsPrefix: string
  readonly commandsPrefix: string
  readonly secMemoriesTitle: string
  readonly memoriesStatsPrefix: string
  readonly memoriesSqliteUnsupported: string
  readonly memoriesFilterAll: string
  readonly memoriesEmpty: string
  readonly deleteMemoryBtn: string
  readonly deleteMemoryConfirm: string
  readonly importanceLabel: string
  readonly secDiagnosticsTitle: string
  readonly diagnosticsDesc: string
  readonly runDiagnosticsBtn: string
  readonly diagnosticsAllOk: string
  readonly diagnosticsHasIssues: string
  readonly badgeOk: string
  readonly badgeFail: string
  readonly versionPiLabel: string
  readonly versionMcLabel: string
  readonly pathsLabel: string
  readonly mcStatusChipTitle: string
  readonly mcStatusLabel: string
  readonly noticeCloseLabel: string
  readonly actionSuccess: string
  readonly actionFailedPrefix: string
}

const EN_STRINGS: PiEcosystemStrings = {
  title: 'Memory & Pi Ecosystem',
  subtitle:
    'Configure the Pi Agent runtime, Magic Context cross-session memory, community packages, and SKILL.md discovery.',
  loading: 'Loading runtime overview…',
  reloadBtn: 'Reload Runtime',
  refreshBtn: 'Refresh',
  envOverrideBanner:
    'GENOFFICE_ASK_ENGINE=legacy is set in the environment and forces the legacy Ask loop for this process.',
  secRuntimeTitle: 'Runtime & Magic Context',
  engineLabel: 'AI Panel Engine',
  engineDesc:
    'Pi engine enables cross-session Magic Context memory, extensions, and SKILL.md ecosystem; Legacy restores the classic loop.',
  enginePi: 'Pi + Magic Context',
  engineLegacy: 'Legacy Loop',
  mcEnabledLabel: 'Enable Magic Context',
  mcEnabledDesc:
    'Maintains long-term SQLite memory compartments and /ctx-* commands inside the AI panel.',
  storageModeLabel: 'Memory Storage Isolation',
  storageModeDesc:
    'Isolated stores Magic Context under GenOffice userData; Shared shares the ~/.pi database.',
  storageIsolated: 'Isolated (Recommended)',
  storageShared: 'Shared (~/.pi)',
  embeddingLabel: 'Local Vector Embeddings',
  embeddingDesc:
    'Off uses instant offline FTS search. Local enables ONNX WASM semantic search (~90 MB model download on first use).',
  embeddingOff: 'Off (FTS Only)',
  embeddingLocal: 'Local (WASM)',
  dreamerLabel: 'Background Dreamer',
  dreamerDesc:
    'Periodically consolidates and deduplicates accumulated episodic memories in the background.',
  historianModelLabel: 'Historian Model Override',
  historianModelDesc:
    'Optional model id (e.g. gpt-4o-mini) for Magic Context compaction/historian. Leave empty to follow the active chat model.',
  dreamerModelLabel: 'Dreamer Model Override',
  dreamerModelDesc:
    'Optional model id for background Dreamer consolidation. Leave empty to follow Historian / active chat model.',
  modelPlaceholder: 'Follow active chat model',
  saveModelBtn: 'Apply',
  readToolsLabel: 'Pi Native Read Tools',
  readToolsDesc: 'Expose built-in read, grep, find, and ls tools to the Pi Agent.',
  writeToolsLabel: 'Pi Native Write & Shell Tools',
  writeToolsDesc:
    'Expose bash, powershell, edit, and write tools (always gated through GenOffice confirmation cards).',
  temporalLabel: 'Temporal Awareness',
  temporalDesc: 'Inject relative timestamps when Magic Context retrieves past episodes.',
  autoHintsLabel: 'Auto Search Hints',
  autoHintsDesc: 'Attach Magic Context memory retrieval hints when relevant context exists.',
  secSystemPromptTitle: 'System Prompt',
  systemPromptDesc:
    'Customize the core instruction prompt used by the AI assistant across both Pi and Legacy engines. Clear or reset to restore the built-in GenOffice office assistant prompt; changes reload automatically.',
  systemPromptBadgeDefault: 'Built-in Default',
  systemPromptBadgeCustom: 'Customized',
  systemPromptPlaceholder: 'Enter custom system prompt instructions for the AI assistant...',
  savePromptBtn: 'Save Prompt',
  resetPromptBtn: 'Reset to Default',
  promptSavedMsg: 'System prompt saved and applied.',
  promptResetMsg: 'Restored built-in default system prompt.',
  secPackagesTitle: 'Pi Community Packages',
  packagesDesc:
    'Install Pi packages via npm spec, git URL, or local directory path (e.g. npm:pi-web-access).',
  packagePlaceholder: 'npm:<package> or git:<url> or /local/path',
  installBtn: 'Install',
  updateAllBtn: 'Update All',
  updateBtn: 'Update',
  removeBtn: 'Remove',
  removePackageConfirm: 'Remove Pi package "{source}"?',
  packagesEmpty: 'No Pi packages installed yet.',
  packageFilteredTag: 'filtered',
  secInventoryTitle: 'Loaded Extensions, Skills & Commands',
  tabExtensions: 'Extensions',
  tabSkills: 'Skills',
  tabCommands: 'Slash Commands',
  inventoryEmpty: 'None discovered.',
  extensionErrorsTitle: 'Extension Load Errors',
  toolsPrefix: 'Tools',
  commandsPrefix: 'Commands',
  secMemoriesTitle: 'Magic Context Long-Term Memories',
  memoriesStatsPrefix: 'Memories',
  memoriesSqliteUnsupported:
    'Built-in node:sqlite is unavailable in this environment; memory browsing is disabled.',
  memoriesFilterAll: 'All Categories',
  memoriesEmpty: 'No long-term memories stored yet.',
  deleteMemoryBtn: 'Delete',
  deleteMemoryConfirm: 'Delete this long-term memory entry? This cannot be undone.',
  importanceLabel: 'Importance',
  secDiagnosticsTitle: 'Runtime Diagnostics',
  diagnosticsDesc:
    'Verifies embedded Pi runtime resolution, node:sqlite availability, and the no-global-Node subagent shim.',
  runDiagnosticsBtn: 'Run Diagnostics',
  diagnosticsAllOk: 'All checks passed',
  diagnosticsHasIssues: 'Issues detected',
  badgeOk: 'OK',
  badgeFail: 'FAIL',
  versionPiLabel: 'Pi Coding Agent',
  versionMcLabel: 'Magic Context',
  pathsLabel: 'Paths',
  mcStatusChipTitle: 'Magic Context active memory & context usage',
  mcStatusLabel: 'MC',
  noticeCloseLabel: 'Dismiss notice',
  actionSuccess: 'Done',
  actionFailedPrefix: 'Error',
}

const ZH_STRINGS: PiEcosystemStrings = {
  title: '记忆与 Pi 生态',
  subtitle: '配置 Pi Agent 运行时、Magic Context 跨会话长期记忆、社区扩展包与 SKILL.md 发现。',
  loading: '正在加载运行时概览…',
  reloadBtn: '重载运行时',
  refreshBtn: '刷新',
  envOverrideBanner:
    '检测到环境变量 GENOFFICE_ASK_ENGINE=legacy，当前进程将强制使用传统问一问引擎。',
  secRuntimeTitle: '运行时与 Magic Context',
  engineLabel: 'AI 面板核心引擎',
  engineDesc:
    'Pi 引擎支持 Magic Context 跨会话长期记忆、Pi 扩展与 SKILL.md 生态；传统引擎保留旧版循环。',
  enginePi: 'Pi + Magic Context',
  engineLegacy: '传统引擎',
  mcEnabledLabel: '启用 Magic Context 记忆',
  mcEnabledDesc: '在 AI 面板中维护 SQLite 长期记忆分区，并提供 /ctx-* 记忆管理命令。',
  storageModeLabel: '记忆存储隔离模式',
  storageModeDesc: '“隔离存储”保存在 GenOffice 用户数据目录下；“共享存储”读写 ~/.pi 公共库。',
  storageIsolated: '隔离存储（推荐）',
  storageShared: '共享（~/.pi）',
  embeddingLabel: '本地语义向量检索',
  embeddingDesc:
    '关闭时使用纯本地 FTS 全文检索（零下载立即可用）；开启本地 WASM 向量首次将下载约 90 MB 模型。',
  embeddingOff: '关闭（仅 FTS）',
  embeddingLocal: '本地（WASM）',
  dreamerLabel: '后台 Dreamer 记忆整理',
  dreamerDesc: '在后台定期归并去重与提炼已积累的片段记忆。',
  historianModelLabel: 'Historian 模型覆写',
  historianModelDesc: '可选指定记忆归档/压缩使用的模型 ID，留空则自动跟随当前对话模型。',
  dreamerModelLabel: 'Dreamer 模型覆写',
  dreamerModelDesc: '可选指定后台 Dreamer 整理使用的模型 ID，留空则跟随 Historian 或当前模型。',
  modelPlaceholder: '跟随当前对话模型',
  saveModelBtn: '应用',
  readToolsLabel: 'Pi 原生只读工具',
  readToolsDesc: '向 Pi Agent 开放内置 read、grep、find、ls 文件检视工具。',
  writeToolsLabel: 'Pi 原生读写与终端工具',
  writeToolsDesc: '开放 bash、powershell、edit、write 工具（均受 GenOffice 权限确认卡片门控）。',
  temporalLabel: '时间感知上下文',
  temporalDesc: '在 Magic Context 召回历史记忆时附带相对时间线索。',
  autoHintsLabel: '自动检索提示',
  autoHintsDesc: '检测到相关历史线索时自动提示 Magic Context 记忆引用。',
  secSystemPromptTitle: 'AI 系统提示词',
  systemPromptDesc:
    '统一配置 AI 助手的核心系统提示词（同时对 Pi 与传统引擎生效）。保存后自动热重载，下一轮对话立即生效；清空或恢复默认即可回退为 GenOffice 内置办公提示词。',
  systemPromptBadgeDefault: '内置默认',
  systemPromptBadgeCustom: '已自定义',
  systemPromptPlaceholder: '输入自定义系统提示词（角色定位、回答规范、工作偏好等）…',
  savePromptBtn: '保存提示词',
  resetPromptBtn: '恢复默认',
  promptSavedMsg: '系统提示词已保存并生效。',
  promptResetMsg: '已恢复为内置默认系统提示词。',
  secPackagesTitle: 'Pi 社区扩展包管理',
  packagesDesc: '通过 npm 包名、git 地址或本地路径安装 Pi 扩展包（如 npm:pi-web-access）。',
  packagePlaceholder: 'npm:<包名> 或 git:<地址> 或 /本地路径',
  installBtn: '安装',
  updateAllBtn: '全部更新',
  updateBtn: '更新',
  removeBtn: '卸载',
  removePackageConfirm: '确定要卸载 Pi 扩展包 “{source}” 吗？',
  packagesEmpty: '暂未安装任何 Pi 社区扩展包。',
  packageFilteredTag: '已过滤',
  secInventoryTitle: '已加载扩展、技能与斜杠命令',
  tabExtensions: '扩展',
  tabSkills: '技能',
  tabCommands: '斜杠命令',
  inventoryEmpty: '暂无发现条目。',
  extensionErrorsTitle: '扩展加载异常',
  toolsPrefix: '注册工具',
  commandsPrefix: '注册命令',
  secMemoriesTitle: 'Magic Context 长期记忆库',
  memoriesStatsPrefix: '记忆条数',
  memoriesSqliteUnsupported: '当前环境未启用内置 node:sqlite，无法直接浏览数据库条目。',
  memoriesFilterAll: '全部分类',
  memoriesEmpty: '暂无已存储的长期记忆。',
  deleteMemoryBtn: '删除',
  deleteMemoryConfirm: '确定要删除这条长期记忆吗？此操作不可撤销。',
  importanceLabel: '重要度',
  secDiagnosticsTitle: '运行时健康自检',
  diagnosticsDesc:
    '检测内置 Pi 运行时路径解析、node:sqlite 支持，以及无全局 Node 环境的 Subagent Shim。',
  runDiagnosticsBtn: '运行自检',
  diagnosticsAllOk: '全部检查通过',
  diagnosticsHasIssues: '发现异常项',
  badgeOk: '正常',
  badgeFail: '异常',
  versionPiLabel: 'Pi Coding Agent',
  versionMcLabel: 'Magic Context',
  pathsLabel: '运行时路径',
  mcStatusChipTitle: 'Magic Context 当前记忆条数与上下文占用',
  mcStatusLabel: '记忆',
  noticeCloseLabel: '关闭提示',
  actionSuccess: '已完成',
  actionFailedPrefix: '失败',
}

const ZH_TW_STRINGS: PiEcosystemStrings = {
  title: '記憶與 Pi 生態',
  subtitle: '設定 Pi Agent 執行時期、Magic Context 跨工作階段長期記憶、社群套件與 SKILL.md 探索。',
  loading: '正在載入執行時期概覽…',
  reloadBtn: '重新載入執行時期',
  refreshBtn: '重新整理',
  envOverrideBanner:
    '環境變數 GENOFFICE_ASK_ENGINE=legacy 已設定，目前程序將強制使用傳統問一問引擎。',
  secRuntimeTitle: '執行時期與 Magic Context',
  engineLabel: 'AI 面板核心引擎',
  engineDesc:
    'Pi 引擎支援 Magic Context 跨工作階段長期記憶、Pi 擴充套件與 SKILL.md 生態；傳統引擎保留舊版迴圈。',
  enginePi: 'Pi + Magic Context',
  engineLegacy: '傳統引擎',
  mcEnabledLabel: '啟用 Magic Context 記憶',
  mcEnabledDesc: '在 AI 面板中維護 SQLite 長期記憶分區，並提供 /ctx-* 記憶管理指令。',
  storageModeLabel: '記憶儲存隔離模式',
  storageModeDesc: '「隔離儲存」保存於 GenOffice 使用者資料目錄；「共用儲存」讀寫 ~/.pi 公共庫。',
  storageIsolated: '隔離儲存（建議）',
  storageShared: '共用（~/.pi）',
  embeddingLabel: '本機語意向量檢索',
  embeddingDesc:
    '關閉時使用純本機 FTS 全文檢索；開啟本機 WASM 向量首次將下載約 90 MB 模型。',
  embeddingOff: '關閉（僅 FTS）',
  embeddingLocal: '本機（WASM）',
  dreamerLabel: '背景 Dreamer 記憶整理',
  dreamerDesc: '在背景定期合併去重並提煉已累積的片段記憶。',
  historianModelLabel: 'Historian 模型覆寫',
  historianModelDesc: '可選指定記憶歸檔/壓縮使用的模型 ID，留空則自動跟隨目前對話模型。',
  dreamerModelLabel: 'Dreamer 模型覆寫',
  dreamerModelDesc: '可選指定背景 Dreamer 整理使用的模型 ID，留空則跟隨 Historian 或目前模型。',
  modelPlaceholder: '跟隨目前對話模型',
  saveModelBtn: '套用',
  readToolsLabel: 'Pi 原生唯讀工具',
  readToolsDesc: '向 Pi Agent 開放內建 read、grep、find、ls 檔案檢視工具。',
  writeToolsLabel: 'Pi 原生讀寫與終端工具',
  writeToolsDesc: '開放 bash、powershell、edit、write 工具（均受 GenOffice 權限確認卡片控管）。',
  temporalLabel: '時間感知上下文',
  temporalDesc: '在 Magic Context 召回歷史記憶時附帶相對時間線索。',
  autoHintsLabel: '自動檢索提示',
  autoHintsDesc: '偵測到相關歷史線索時自動提示 Magic Context 記憶參照。',
  secSystemPromptTitle: 'AI 系統提示詞',
  systemPromptDesc:
    '統一設定 AI 助手的核心系統提示詞（同時對 Pi 與傳統引擎生效）。儲存後自動熱重載，下一輪對話立即生效；清空或還原預設即可恢復為 GenOffice 內建辦公提示詞。',
  systemPromptBadgeDefault: '內建預設',
  systemPromptBadgeCustom: '已自訂',
  systemPromptPlaceholder: '輸入自訂系統提示詞（角色定位、回答規範、工作偏好等）…',
  savePromptBtn: '儲存提示詞',
  resetPromptBtn: '還原預設',
  promptSavedMsg: '系統提示詞已儲存並生效。',
  promptResetMsg: '已還原為內建預設系統提示詞。',
  secPackagesTitle: 'Pi 社群擴充套件管理',
  packagesDesc: '透過 npm 套件名稱、git 位址或本機路徑安裝 Pi 擴充套件（如 npm:pi-web-access）。',
  packagePlaceholder: 'npm:<套件> 或 git:<網址> 或 /本機路徑',
  installBtn: '安裝',
  updateAllBtn: '全部更新',
  updateBtn: '更新',
  removeBtn: '移除',
  removePackageConfirm: '確定要移除 Pi 擴充套件「{source}」嗎？',
  packagesEmpty: '尚未安裝任何 Pi 社群擴充套件。',
  packageFilteredTag: '已篩選',
  secInventoryTitle: '已載入擴充、技能與斜線指令',
  tabExtensions: '擴充套件',
  tabSkills: '技能',
  tabCommands: '斜線指令',
  inventoryEmpty: '尚無探索結果。',
  extensionErrorsTitle: '擴充套件載入錯誤',
  toolsPrefix: '註冊工具',
  commandsPrefix: '註冊指令',
  secMemoriesTitle: 'Magic Context 長期記憶庫',
  memoriesStatsPrefix: '記憶筆數',
  memoriesSqliteUnsupported: '目前環境未啟用內建 node:sqlite，無法瀏覽資料庫內容。',
  memoriesFilterAll: '全部分類',
  memoriesEmpty: '尚未儲存長期記憶。',
  deleteMemoryBtn: '刪除',
  deleteMemoryConfirm: '確定要刪除這筆長期記憶嗎？此操作無法復原。',
  importanceLabel: '重要度',
  secDiagnosticsTitle: '執行時期自我檢測',
  diagnosticsDesc:
    '驗證內嵌 Pi 執行時期路徑解析、node:sqlite 支援度，以及無全域 Node 環境的 Subagent Shim。',
  runDiagnosticsBtn: '執行檢測',
  diagnosticsAllOk: '全部項目通過',
  diagnosticsHasIssues: '發現異常項目',
  badgeOk: '正常',
  badgeFail: '異常',
  versionPiLabel: 'Pi Coding Agent',
  versionMcLabel: 'Magic Context',
  pathsLabel: '執行時期路徑',
  mcStatusChipTitle: 'Magic Context 目前記憶筆數與上下文佔用',
  mcStatusLabel: '記憶',
  noticeCloseLabel: '關閉通知',
  actionSuccess: '已完成',
  actionFailedPrefix: '錯誤',
}

/** Return localized copy for the Memory & Pi Ecosystem pane, defaulting to English. */
export function getPiEcosystemStrings(lang: Lang): PiEcosystemStrings {
  if (lang === 'zh') return ZH_STRINGS
  if (lang === 'zh-TW') return ZH_TW_STRINGS
  return EN_STRINGS
}
