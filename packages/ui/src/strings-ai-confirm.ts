import type { Lang } from '@genoffice/i18n'

/** Labels for the inline tool-confirmation card (all AI panels share them). */
export interface AiConfirmLabels {
  /** card title naming what is being asked */
  title: string
  /** what the call wants to do, prefixed by nothing: "{title} run_genoffice" */
  toolLabel: (name: string) => string
  /** collapsed row label for the tool arguments */
  argsLabel: string
  /** allow this one call */
  allow: string
  /**
   * Always allow this tool — rendered only for requests that offer it (never
   * for destructive 'always-ask' tools). The scope the words promise is the
   * HOST's own: the editor apps' panels scope their set per conversation
   * (this table's default wording), the shell's panels share one main-side
   * app-session set (the session-worded variant below).
   */
  allowSession: string
  deny: string
  /** card state while the decision is pending (before a click) */
  awaitingHint: string
  /** outcome shown on the card after the user allowed it */
  allowedNote: string
  /** outcome shown on the card after the user chose the always-allow button */
  allowedSessionNote: string
  /** outcome shown on the card after the user (or the timeout) denied it */
  deniedNote: string
  /** footnote: silence counts as denial */
  timeoutHint: (minutes: number) => string
}

/**
 * The always-allow copy worded for the SHELL's session scope: the set lives
 * main-side and spans both panel mounts, every thread, and the whole app
 * run — "this session" says what the button does there, where "this
 * conversation" (the default table the editor apps' panels keep) would
 * under-promise it.
 */
export interface AiSessionConfirmVariant {
  allowSession: string
  allowedSessionNote: string
}

export const AI_SESSION_CONFIRM_LABELS: Record<Lang, AiSessionConfirmVariant> = {
  zh: { allowSession: '始终允许（本会话）', allowedSessionNote: '已允许（本会话）' },
  en: {
    allowSession: 'Always allow (this session)',
    allowedSessionNote: 'Allowed for this app session',
  },
  ja: {
    allowSession: 'このセッションでは常に許可',
    allowedSessionNote: 'このセッションでは常に許可しました',
  },
  ko: {
    allowSession: '이 세션에서 항상 허용',
    allowedSessionNote: '이 세션에서 항상 허용됨',
  },
  fr: {
    allowSession: 'Toujours autoriser (cette session)',
    allowedSessionNote: 'Autorisé pour cette session',
  },
  de: {
    allowSession: 'Immer erlauben (diese Sitzung)',
    allowedSessionNote: 'Für diese Sitzung erlaubt',
  },
  es: {
    allowSession: 'Permitir siempre (esta sesión)',
    allowedSessionNote: 'Permitida en esta sesión',
  },
  th: {
    allowSession: 'อนุญาตเสมอ (ในเซสชันนี้)',
    allowedSessionNote: 'อนุญาตเสมอในเซสชันนี้',
  },
  id: {
    allowSession: 'Selalu izinkan (sesi aplikasi ini)',
    allowedSessionNote: 'Diizinkan untuk sesi aplikasi ini',
  },
  ru: {
    allowSession: 'Всегда разрешать (в этой сессии)',
    allowedSessionNote: 'Разрешено для этой сессии',
  },
  ar: {
    allowSession: 'السماح دائمًا (في هذه الجلسة)',
    allowedSessionNote: 'مسموح به في هذه الجلسة',
  },
  pt: {
    allowSession: 'Permitir sempre (nesta sessão)',
    allowedSessionNote: 'Permitida nesta sessão',
  },
  it: {
    allowSession: 'Consenti sempre (in questa sessione)',
    allowedSessionNote: 'Consentita in questa sessione',
  },
  pl: {
    allowSession: 'Zawsze zezwalaj (w tej sesji)',
    allowedSessionNote: 'Zezwolono w tej sesji',
  },
  cs: {
    allowSession: 'Vždy povolit (v této relaci)',
    allowedSessionNote: 'Povoleno pro tuto relaci',
  },
  nl: {
    allowSession: 'Altijd toestaan (deze sessie)',
    allowedSessionNote: 'Toegestaan voor deze sessie',
  },
  ms: {
    allowSession: 'Sentiasa benarkan (sesi aplikasi ini)',
    allowedSessionNote: 'Dibenarkan untuk sesi aplikasi ini',
  },
  he: {
    allowSession: 'אפשר תמיד (בהפעלה זו)',
    allowedSessionNote: 'אושר עבור הפעלה זו',
  },
  hi: {
    allowSession: 'हमेशा अनुमति दें (इस सेशन में)',
    allowedSessionNote: 'इस सेशन के लिए अनुमति दी गई',
  },
  'zh-TW': { allowSession: '始終允許（本會話）', allowedSessionNote: '已允許（本會話）' },
  vi: {
    allowSession: 'Luôn cho phép (trong phiên làm việc này)',
    allowedSessionNote: 'Đã cho phép trong phiên làm việc này',
  },
}

const SESSION_LABEL_CACHE = new Map<Lang, AiConfirmLabels>()

/**
 * The shared labels with the always-allow pair worded for the shell's
 * app-session set (see AI_SESSION_CONFIRM_LABELS). One stable object per
 * language — memoized rows compare labels by identity.
 */
export function aiSessionConfirmLabels(lang: Lang): AiConfirmLabels {
  let labels = SESSION_LABEL_CACHE.get(lang)
  if (!labels) {
    labels = {
      ...(AI_CONFIRM_LABELS[lang] ?? AI_CONFIRM_LABELS.en),
      ...AI_SESSION_CONFIRM_LABELS[lang],
    }
    SESSION_LABEL_CACHE.set(lang, labels)
  }
  return labels
}

export const AI_CONFIRM_LABELS: Record<Lang, AiConfirmLabels> = {
  zh: {
    title: 'AI 请求执行一项高风险操作',
    toolLabel: (name) => `工具:${name}`,
    argsLabel: '参数',
    allow: '允许本次',
    allowSession: '始终允许（本会话）',
    deny: '拒绝',
    awaitingHint: '等待你的确认…',
    allowedNote: '已允许',
    allowedSessionNote: '已允许（本会话）',
    deniedNote: '已拒绝',
    timeoutHint: (minutes) => `${minutes} 分钟内未选择将视为拒绝。`,
  },
  en: {
    title: 'The AI asks to run a high-risk action',
    toolLabel: (name) => `Tool: ${name}`,
    argsLabel: 'Arguments',
    allow: 'Allow once',
    allowSession: 'Always allow (this conversation)',
    deny: 'Deny',
    awaitingHint: 'Waiting for your decision…',
    allowedNote: 'Allowed',
    allowedSessionNote: 'Allowed for this conversation',
    deniedNote: 'Denied',
    timeoutHint: (minutes) => `No choice within ${minutes} minutes counts as denied.`,
  },
  ja: {
    title: 'AI が高リスク操作の実行を求めています',
    toolLabel: (name) => `ツール:${name}`,
    argsLabel: '引数',
    allow: '今回のみ許可',
    allowSession: 'この会話では常に許可',
    deny: '拒否',
    awaitingHint: '判断を待っています…',
    allowedNote: '許可しました',
    allowedSessionNote: 'この会話では常に許可しました',
    deniedNote: '拒否しました',
    timeoutHint: (minutes) => `${minutes} 分以内に選択しない場合は拒否となります。`,
  },
  ko: {
    title: 'AI가 고위험 작업 실행을 요청합니다',
    toolLabel: (name) => `도구: ${name}`,
    argsLabel: '인수',
    allow: '한 번만 허용',
    allowSession: '이 대화에서 항상 허용',
    deny: '거부',
    awaitingHint: '결정을 기다리는 중…',
    allowedNote: '허용됨',
    allowedSessionNote: '이 대화에서 항상 허용됨',
    deniedNote: '거부됨',
    timeoutHint: (minutes) => `${minutes}분 안에 선택하지 않으면 거부로 처리됩니다.`,
  },
  fr: {
    title: "L'IA demande à exécuter une action à risque",
    toolLabel: (name) => `Outil : ${name}`,
    argsLabel: 'Arguments',
    allow: 'Autoriser une fois',
    allowSession: 'Toujours autoriser (cette conversation)',
    deny: 'Refuser',
    awaitingHint: 'En attente de votre décision…',
    allowedNote: 'Autorisé',
    allowedSessionNote: 'Autorisé pour cette conversation',
    deniedNote: 'Refusé',
    timeoutHint: (minutes) => `Sans choix sous ${minutes} minutes, la demande est refusée.`,
  },
  de: {
    title: 'Die KI möchte eine riskante Aktion ausführen',
    toolLabel: (name) => `Werkzeug: ${name}`,
    argsLabel: 'Argumente',
    allow: 'Einmal erlauben',
    allowSession: 'Immer erlauben (dieses Gespräch)',
    deny: 'Ablehnen',
    awaitingHint: 'Warte auf Ihre Entscheidung…',
    allowedNote: 'Erlaubt',
    allowedSessionNote: 'Für dieses Gespräch erlaubt',
    deniedNote: 'Abgelehnt',
    timeoutHint: (minutes) =>
      `Ohne Auswahl innerhalb von ${minutes} Minuten gilt die Anfrage als abgelehnt.`,
  },
  es: {
    title: 'La IA pide ejecutar una acción de riesgo',
    toolLabel: (name) => `Herramienta: ${name}`,
    argsLabel: 'Argumentos',
    allow: 'Permitir una vez',
    allowSession: 'Permitir siempre (esta conversación)',
    deny: 'Denegar',
    awaitingHint: 'Esperando tu decisión…',
    allowedNote: 'Permitida',
    allowedSessionNote: 'Permitida en esta conversación',
    deniedNote: 'Denegada',
    timeoutHint: (minutes) => `Si no eliges en ${minutes} minutos, se deniega.`,
  },
  th: {
    title: 'AI ขออนุญาตรันการทำงานที่มีความเสี่ยง',
    toolLabel: (name) => `เครื่องมือ: ${name}`,
    argsLabel: 'อาร์กิวเมนต์',
    allow: 'อนุญาตครั้งนี้',
    allowSession: 'อนุญาตเสมอ (ในบทสนทนานี้)',
    deny: 'ปฏิเสธ',
    awaitingHint: 'กำลังรอการตัดสินใจของคุณ…',
    allowedNote: 'อนุญาตแล้ว',
    allowedSessionNote: 'อนุญาตเสมอในบทสนทนานี้',
    deniedNote: 'ปฏิเสธแล้ว',
    timeoutHint: (minutes) => `หากไม่เลือกภายใน ${minutes} นาที จะถือว่าปฏิเสธ`,
  },
  id: {
    title: 'AI meminta izin menjalankan tindakan berisiko tinggi',
    toolLabel: (name) => `Alat: ${name}`,
    argsLabel: 'Argumen',
    allow: 'Izinkan sekali',
    allowSession: 'Selalu izinkan (percakapan ini)',
    deny: 'Tolak',
    awaitingHint: 'Menunggu keputusan Anda…',
    allowedNote: 'Diizinkan',
    allowedSessionNote: 'Diizinkan untuk percakapan ini',
    deniedNote: 'Ditolak',
    timeoutHint: (minutes) => `Tanpa pilihan dalam ${minutes} menit, permintaan ditolak.`,
  },
  ru: {
    title: 'ИИ просит выполнить рискованное действие',
    toolLabel: (name) => `Инструмент: ${name}`,
    argsLabel: 'Аргументы',
    allow: 'Разрешить один раз',
    allowSession: 'Всегда разрешать (в этом диалоге)',
    deny: 'Отклонить',
    awaitingHint: 'Ожидание вашего решения…',
    allowedNote: 'Разрешено',
    allowedSessionNote: 'Разрешено для этого диалога',
    deniedNote: 'Отклонено',
    timeoutHint: (minutes) => `Без выбора в течение ${minutes} минут запрос считается отклонённым.`,
  },
  ar: {
    title: 'يطلب الذكاء الاصطناعي تنفيذ إجراء عالي الخطورة',
    toolLabel: (name) => `الأداة: ${name}`,
    argsLabel: 'الوسائط',
    allow: 'السماح مرة واحدة',
    allowSession: 'السماح دائمًا (في هذه المحادثة)',
    deny: 'رفض',
    awaitingHint: 'في انتظار قرارك…',
    allowedNote: 'تم السماح',
    allowedSessionNote: 'مسموح به في هذه المحادثة',
    deniedNote: 'تم الرفض',
    timeoutHint: (minutes) => `عدم الاختيار خلال ${minutes} دقيقة يُحتسب رفضًا.`,
  },
  pt: {
    title: 'A IA pede para executar uma ação de risco',
    toolLabel: (name) => `Ferramenta: ${name}`,
    argsLabel: 'Argumentos',
    allow: 'Permitir uma vez',
    allowSession: 'Permitir sempre (nesta conversa)',
    deny: 'Negar',
    awaitingHint: 'Aguardando sua decisão…',
    allowedNote: 'Permitida',
    allowedSessionNote: 'Permitida nesta conversa',
    deniedNote: 'Negada',
    timeoutHint: (minutes) => `Sem escolha em ${minutes} minutos, o pedido é negado.`,
  },
  it: {
    title: "L'IA chiede di eseguire un'azione a rischio",
    toolLabel: (name) => `Strumento: ${name}`,
    argsLabel: 'Argomenti',
    allow: 'Consenti una volta',
    allowSession: 'Consenti sempre (in questa conversazione)',
    deny: 'Nega',
    awaitingHint: 'In attesa della tua decisione…',
    allowedNote: 'Consentita',
    allowedSessionNote: 'Consentita in questa conversazione',
    deniedNote: 'Negata',
    timeoutHint: (minutes) => `Senza una scelta entro ${minutes} minuti, la richiesta è negata.`,
  },
  pl: {
    title: 'AI prosi o wykonanie ryzykownej operacji',
    toolLabel: (name) => `Narzędzie: ${name}`,
    argsLabel: 'Argumenty',
    allow: 'Zezwól raz',
    allowSession: 'Zawsze zezwalaj (w tej rozmowie)',
    deny: 'Odmów',
    awaitingHint: 'Czekanie na Twoją decyzję…',
    allowedNote: 'Zezwolono',
    allowedSessionNote: 'Zezwolono w tej rozmowie',
    deniedNote: 'Odmówiono',
    timeoutHint: (minutes) => `Brak wyboru w ciągu ${minutes} minut oznacza odmowę.`,
  },
  cs: {
    title: 'AI žádá o spuštění rizikové operace',
    toolLabel: (name) => `Nástroj: ${name}`,
    argsLabel: 'Argumenty',
    allow: 'Povolit jednou',
    allowSession: 'Vždy povolit (v této konverzaci)',
    deny: 'Zamítnout',
    awaitingHint: 'Čeká se na vaše rozhodnutí…',
    allowedNote: 'Povoleno',
    allowedSessionNote: 'Povoleno pro tuto konverzaci',
    deniedNote: 'Zamítnuto',
    timeoutHint: (minutes) => `Bez volby do ${minutes} minut se žádost zamítne.`,
  },
  nl: {
    title: 'De AI wil een risicovolle actie uitvoeren',
    toolLabel: (name) => `Tool: ${name}`,
    argsLabel: 'Argumenten',
    allow: 'Eenmalig toestaan',
    allowSession: 'Altijd toestaan (dit gesprek)',
    deny: 'Weigeren',
    awaitingHint: 'Wachten op je beslissing…',
    allowedNote: 'Toegestaan',
    allowedSessionNote: 'Toegestaan voor dit gesprek',
    deniedNote: 'Geweigerd',
    timeoutHint: (minutes) => `Geen keuze binnen ${minutes} minuten telt als geweigerd.`,
  },
  ms: {
    title: 'AI meminta kebenaran untuk menjalankan tindakan berisiko',
    toolLabel: (name) => `Alat: ${name}`,
    argsLabel: 'Argumen',
    allow: 'Benarkan sekali',
    allowSession: 'Sentiasa benarkan (perbualan ini)',
    deny: 'Tolak',
    awaitingHint: 'Menunggu keputusan anda…',
    allowedNote: 'Dibenarkan',
    allowedSessionNote: 'Dibenarkan untuk perbualan ini',
    deniedNote: 'Ditolak',
    timeoutHint: (minutes) => `Tiada pilihan dalam masa ${minutes} minit dianggap ditolak.`,
  },
  he: {
    title: 'הבינה המלאכותית מבקשת להריץ פעולה מסוכנת',
    toolLabel: (name) => `כלי: ${name}`,
    argsLabel: 'ארגומנטים',
    allow: 'אפשר פעם אחת',
    allowSession: 'אפשר תמיד (בשיחה זו)',
    deny: 'דחה',
    awaitingHint: 'ממתין להחלטתך…',
    allowedNote: 'אושר',
    allowedSessionNote: 'אושר עבור שיחה זו',
    deniedNote: 'נדחה',
    timeoutHint: (minutes) => `אי־בחירה בתוך ${minutes} דקות נחשבת כדחייה.`,
  },
  hi: {
    title: 'AI एक उच्च-जोखिम कार्य चलाने की अनुमति मांगता है',
    toolLabel: (name) => `टूल: ${name}`,
    argsLabel: 'आर्ग्युमेंट्स',
    allow: 'एक बार अनुमति दें',
    allowSession: 'हमेशा अनुमति दें (इस बातचीत में)',
    deny: 'अस्वीकार करें',
    awaitingHint: 'आपके निर्णय की प्रतीक्षा…',
    allowedNote: 'अनुमति दी गई',
    allowedSessionNote: 'इस बातचीत के लिए अनुमति दी गई',
    deniedNote: 'अस्वीकार किया गया',
    timeoutHint: (minutes) => `${minutes} मिनट में कोई विकल्प न चुनने पर अस्वीकार माना जाएगा।`,
  },
  'zh-TW': {
    title: 'AI 請求執行高風險操作',
    toolLabel: (name) => `工具:${name}`,
    argsLabel: '參數',
    allow: '允許本次',
    allowSession: '始終允許（本會話）',
    deny: '拒絕',
    awaitingHint: '等待你的確認…',
    allowedNote: '已允許',
    allowedSessionNote: '已允許（本會話）',
    deniedNote: '已拒絕',
    timeoutHint: (minutes) => `${minutes} 分鐘內未選擇將視為拒絕。`,
  },
  vi: {
    title: 'AI xin phép chạy một thao tác rủi ro cao',
    toolLabel: (name) => `Công cụ: ${name}`,
    argsLabel: 'Tham số',
    allow: 'Cho phép một lần',
    allowSession: 'Luôn cho phép (trong cuộc trò chuyện này)',
    deny: 'Từ chối',
    awaitingHint: 'Đang chờ quyết định của bạn…',
    allowedNote: 'Đã cho phép',
    allowedSessionNote: 'Đã cho phép trong cuộc trò chuyện này',
    deniedNote: 'Đã từ chối',
    timeoutHint: (minutes) => `Không chọn trong ${minutes} phút sẽ bị coi là từ chối.`,
  },
}
