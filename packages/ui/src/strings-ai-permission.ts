import type { Lang } from '@genoffice/i18n'
import type { AiPermissionMode } from './ai-permission-mode'

/** The permission-mode picker's copy: mode names (the chip text) plus a one-line hint each. */
export interface AiPermissionModeStrings {
  /** chip tooltip / listbox name */
  title: string
  names: Readonly<Record<AiPermissionMode, string>>
  hints: Readonly<Record<AiPermissionMode, string>>
}

export const AI_PERMISSION_MODE_STRINGS: Record<Lang, AiPermissionModeStrings> = {
  zh: {
    title: '权限模式',
    names: { auto: '完全自动', smart: '必要时询问', paranoid: '始终询问' },
    hints: {
      auto: '所有工具直接执行，无需确认；删除只进系统回收站，可恢复',
      smart: '高风险操作先询问一次，本次运行内记住“始终允许”',
      paranoid: '每个有副作用的操作都会询问，纯读取操作不询问',
    },
  },
  en: {
    title: 'Permission mode',
    names: { auto: 'Fully automatic', smart: 'Ask when needed', paranoid: 'Always ask' },
    hints: {
      auto: 'Every tool runs without asking; deletions only go to the OS trash',
      smart: 'High-risk actions ask once; "always allow" lasts this app session',
      paranoid: 'Every side effect asks; pure reads never do',
    },
  },
  ja: {
    title: '権限モード',
    names: { auto: '完全自動', smart: '必要時に確認', paranoid: '常に確認' },
    hints: {
      auto: 'すべてのツールが確認なしで実行。削除は OS のごみ箱へ移動し復元できます',
      smart: '高リスク操作は一度だけ確認。「常に許可」は今回の起動中のみ有効',
      paranoid: '副作用のある操作はすべて確認。読み取りのみの操作は確認しません',
    },
  },
  ko: {
    title: '권한 모드',
    names: { auto: '완전 자동', smart: '필요 시 확인', paranoid: '항상 확인' },
    hints: {
      auto: '모든 도구가 확인 없이 실행됩니다. 삭제는 OS 휴지통으로 이동하며 복구할 수 있습니다',
      smart: '고위험 작업은 한 번만 확인합니다. "항상 허용"은 이번 실행 동안 유지됩니다',
      paranoid: '부작용이 있는 모든 작업을 확인합니다. 읽기 전용 작업은 확인하지 않습니다',
    },
  },
  fr: {
    title: 'Mode de permission',
    names: { auto: 'Tout automatique', smart: 'Demander si besoin', paranoid: 'Toujours demander' },
    hints: {
      auto: 'Chaque outil s’exécute sans demander ; les suppressions vont à la corbeille de l’OS',
      smart:
        'Les actions risquées demandent une fois ; « toujours autoriser » vaut pour cette session',
      paranoid: 'Chaque effet de bord demande ; les simples lectures jamais',
    },
  },
  de: {
    title: 'Berechtigungsmodus',
    names: { auto: 'Vollautomatisch', smart: 'Bei Bedarf fragen', paranoid: 'Immer fragen' },
    hints: {
      auto: 'Jedes Werkzeug läuft ohne Nachfrage; Löschungen gehen nur in den OS-Papierkorb',
      smart: 'Risikoreiche Aktionen fragen einmal; „immer erlauben“ gilt für diese App-Sitzung',
      paranoid: 'Jede Nebenwirkung fragt; reine Lesevorgänge nie',
    },
  },
  es: {
    title: 'Modo de permisos',
    names: {
      auto: 'Todo automático',
      smart: 'Preguntar si hace falta',
      paranoid: 'Preguntar siempre',
    },
    hints: {
      auto: 'Cada herramienta se ejecuta sin preguntar; los borrados van a la papelera del sistema',
      smart: 'Las acciones de riesgo preguntan una vez; «permitir siempre» dura esta sesión',
      paranoid: 'Cada efecto secundario pregunta; las puras lecturas nunca',
    },
  },
  th: {
    title: 'โหมดสิทธิ์',
    names: { auto: 'อัตโนมัติเต็มรูปแบบ', smart: 'ถามเมื่อจำเป็น', paranoid: 'ถามทุกครั้ง' },
    hints: {
      auto: 'ทุกเครื่องมือทำงานโดยไม่ถาม การลบจะไปที่ถังขยะของระบบและกู้คืนได้',
      smart: 'การกระทำความเสี่ยงสูงถามครั้งเดียว "อนุญาตเสมอ" ใช้ได้ตลอดการเปิดโปรแกรมครั้งนี้',
      paranoid: 'ทุกการกระทำที่มีผลข้างเคียงจะถาม การอ่านอย่างเดียวไม่ถาม',
    },
  },
  id: {
    title: 'Mode izin',
    names: { auto: 'Sepenuhnya otomatis', smart: 'Tanya bila perlu', paranoid: 'Selalu tanya' },
    hints: {
      auto: 'Setiap alat berjalan tanpa bertanya; penghapusan hanya masuk ke tong sampah OS',
      smart:
        'Aksi berisiko tinggi bertanya sekali; "selalu izinkan" berlaku selama sesi aplikasi ini',
      paranoid: 'Setiap efek samping bertanya; membaca saja tidak pernah bertanya',
    },
  },
  ru: {
    title: 'Режим разрешений',
    names: {
      auto: 'Полностью автоматически',
      smart: 'Спрашивать при необходимости',
      paranoid: 'Спрашивать всегда',
    },
    hints: {
      auto: 'Каждый инструмент выполняется без вопросов; удаление — только в корзину ОС',
      smart:
        'Рискованные действия спрашивают один раз; «всегда разрешать» действует до перезапуска',
      paranoid: 'Любое действие с эффектами спрашивает; простое чтение — никогда',
    },
  },
  ar: {
    title: 'وضع الأذونات',
    names: { auto: 'آلي بالكامل', smart: 'السؤال عند الحاجة', paranoid: 'السؤال دائمًا' },
    hints: {
      auto: 'تعمل كل أداة دون سؤال؛ الحذف يذهب إلى سلة المهملات فقط ويمكن استرجاعه',
      smart: 'تُسأل الإجراءات عالية الخطورة مرة واحدة؛ «السماح دائمًا» يستمر حتى إغلاق التطبيق',
      paranoid: 'يُسأل كل إجراء له تأثير؛ القراءة فقط لا تُسأل أبدًا',
    },
  },
  pt: {
    title: 'Modo de permissão',
    names: {
      auto: 'Tudo automático',
      smart: 'Perguntar se precisar',
      paranoid: 'Perguntar sempre',
    },
    hints: {
      auto: 'Cada ferramenta executa sem perguntar; exclusões vão só para a lixeira do sistema',
      smart: 'Ações de risco perguntam uma vez; "sempre permitir" vale por esta sessão do app',
      paranoid: 'Cada efeito colateral pergunta; leituras puras nunca',
    },
  },
  it: {
    title: 'Modalità permessi',
    names: { auto: 'Tutto automatico', smart: 'Chiedi se serve', paranoid: 'Chiedi sempre' },
    hints: {
      auto: 'Ogni strumento viene eseguito senza chiedere; le eliminazioni vanno nel cestino del sistema',
      smart: 'Le azioni a rischio chiedono una volta; «consenti sempre» vale per questa sessione',
      paranoid: 'Ogni effetto collaterale chiede; le pure letture mai',
    },
  },
  pl: {
    title: 'Tryb uprawnień',
    names: { auto: 'W pełni automatycznie', smart: 'Pytaj, gdy trzeba', paranoid: 'Pytaj zawsze' },
    hints: {
      auto: 'Każde narzędzie działa bez pytania; usunięcia trafiają tylko do kosza systemu',
      smart: 'Ryzykowne działania pytają raz; „zawsze pozwalaj” działa do końca tej sesji',
      paranoid: 'Każde działanie ze skutkiem pyta; czysty odczyt nigdy',
    },
  },
  cs: {
    title: 'Režim oprávnění',
    names: {
      auto: 'Plně automaticky',
      smart: 'Ptát se, když je potřeba',
      paranoid: 'Ptát se vždy',
    },
    hints: {
      auto: 'Každý nástroj běží bez dotazu; mazání jde jen do systémového koše',
      smart: 'Rizikové akce se zeptají jednou; „vždy povolit“ platí pro tuto relaci',
      paranoid: 'Každý vedlejší efekt se ptá; čisté čtení nikdy',
    },
  },
  nl: {
    title: 'Toestemmingsmodus',
    names: {
      auto: 'Volledig automatisch',
      smart: 'Vragen indien nodig',
      paranoid: 'Altijd vragen',
    },
    hints: {
      auto: 'Elke tool draait zonder vraag; verwijderingen gaan alleen naar de prullenbak van het OS',
      smart: 'Risicovolle acties vragen één keer; „altijd toestaan” geldt zolang de app draait',
      paranoid: 'Elke bijwerking vraagt; louter lezen nooit',
    },
  },
  ms: {
    title: 'Mod kebenaran',
    names: { auto: 'Sepenuhnya automatik', smart: 'Tanya bila perlu', paranoid: 'Sentiasa tanya' },
    hints: {
      auto: 'Setiap alat berjalan tanpa bertanya; pemadaman hanya ke tong kitar semula OS',
      smart:
        'Tindakan berisiko tinggi bertanya sekali; "sentiasa benarkan" berlangsung selama sesi app ini',
      paranoid: 'Setiap kesan sampingan bertanya; bacaan semata-mata tidak pernah',
    },
  },
  he: {
    title: 'מצב הרשאות',
    names: { auto: 'אוטומטי לחלוטין', smart: 'לשאול בעת הצורך', paranoid: 'לשאול תמיד' },
    hints: {
      auto: 'כל כלי פועל בלי שאלה; מחיקות הולכות רק לסל המיחזור של מערכת ההפעלה',
      smart: 'פעולות מסוכנות שואלות פעם אחת; „לאפשר תמיד” תקף עד סגירת האפליקציה',
      paranoid: 'כל פעולה עם תופעת לוואי שואלת; קריאה טהורה אף פעם לא',
    },
  },
  hi: {
    title: 'अनुमति मोड',
    names: { auto: 'पूर्णतः स्वचालित', smart: 'ज़रूरत पर पूछें', paranoid: 'हमेशा पूछें' },
    hints: {
      auto: 'हर टूल बिना पूछे चलता है; मिटाई गई फ़ाइलें केवल OS रीसायकल बिन में जाती हैं',
      smart: 'जोखिम भरी क्रियाएँ एक बार पूछती हैं; "हमेशा अनुमति दें" ऐप के इस सेशन तक चलता है',
      paranoid: 'हर साइड-इफ़ेक्ट वाली क्रिया पूछती है; केवल पढ़ने वाली क्रियाएँ कभी नहीं',
    },
  },
  'zh-TW': {
    title: '權限模式',
    names: { auto: '完全自動', smart: '必要時詢問', paranoid: '始終詢問' },
    hints: {
      auto: '所有工具直接執行，無需確認；刪除只進系統垃圾桶，可復原',
      smart: '高風險操作先詢問一次，本次執行期間記住「始終允許」',
      paranoid: '每個有副作用的操作都會詢問，純讀取操作不詢問',
    },
  },
  vi: {
    title: 'Chế độ quyền',
    names: { auto: 'Tự động hoàn toàn', smart: 'Hỏi khi cần', paranoid: 'Luôn hỏi' },
    hints: {
      auto: 'Mọi công cụ chạy không cần hỏi; xóa chỉ đưa vào thùng rác của hệ điều hành',
      smart: 'Hành động rủi ro hỏi một lần; "luôn cho phép" có hiệu lực trong phiên chạy này',
      paranoid: 'Mọi thao tác có tác dụng phụ đều hỏi; đọc thuần túy thì không',
    },
  },
}
