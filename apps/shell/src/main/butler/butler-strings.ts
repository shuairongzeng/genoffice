import { createI18n, type Lang } from '@genoffice/i18n'

export type ButlerStringKey =
  | 'notifyDoneTitle'
  | 'notifyErrorTitle'
  | 'notifyConfirmTitle'
  | 'notifyDoneBody'
  | 'notifyErrorBody'
  | 'notifyConfirmBody'
  | 'speakDone'
  | 'speakError'
  | 'errorEmptyReply'
  | 'trayButler'

const dicts = {
  zh: {
    notifyDoneTitle: '{name} · 任务完成',
    notifyErrorTitle: '{name} · 任务未完成',
    notifyConfirmTitle: '{name} · 需要你确认',
    notifyDoneBody: '{honorific}，「{title}」已完成。{summary}',
    notifyErrorBody: '「{title}」遇到问题：{error}',
    notifyConfirmBody: '「{title}」正在等待你批准：{tool}',
    speakDone: '{honorific}，「{title}」已完成。',
    speakError: '{honorific}，「{title}」没能完成。',
    errorEmptyReply: '没有收到任何回复，可能被记忆插件拒绝或模型未输出，请在 AI 面板查看详情',
    trayButler: '唤起 AI 管家',
  },
  en: {
    notifyDoneTitle: '{name} · Task completed',
    notifyErrorTitle: '{name} · Task incomplete',
    notifyConfirmTitle: '{name} · Confirmation needed',
    notifyDoneBody: '{honorific}, "{title}" is done. {summary}',
    notifyErrorBody: '"{title}" encountered a problem: {error}',
    notifyConfirmBody: '"{title}" is waiting for your approval: {tool}',
    speakDone: '{honorific}, "{title}" is done.',
    speakError: '{honorific}, "{title}" could not be completed.',
    errorEmptyReply:
      'No reply was received (the memory plugin may have refused the turn or the model produced nothing). Open the AI panel for details.',
    trayButler: 'Summon AI Butler',
  },
  ja: {
    notifyDoneTitle: '{name} · タスク完了',
    notifyErrorTitle: '{name} · タスク未完了',
    notifyConfirmTitle: '{name} · 確認が必要です',
    notifyDoneBody: '{honorific}、「{title}」が完了しました。{summary}',
    notifyErrorBody: '「{title}」で問題が発生しました：{error}',
    notifyConfirmBody: '「{title}」が承認を待っています：{tool}',
    speakDone: '{honorific}、「{title}」が完了しました。',
    speakError: '{honorific}、「{title}」を完了できませんでした。',
    errorEmptyReply:
      '応答を受信できませんでした（メモリプラグインによる拒否またはモデル未出力の可能性があります）。AI パネルで詳細を確認してください。',
    trayButler: 'AI バトラーを呼び出す',
  },
  ko: {
    notifyDoneTitle: '{name} · 작업 완료',
    notifyErrorTitle: '{name} · 작업 미완료',
    notifyConfirmTitle: '{name} · 확인 필요',
    notifyDoneBody: '{honorific}, "{title}" 작업이 완료되었습니다. {summary}',
    notifyErrorBody: '"{title}" 작업 중 문제가 발생했습니다: {error}',
    notifyConfirmBody: '"{title}" 작업이 승인을 기다리고 있습니다: {tool}',
    speakDone: '{honorific}, "{title}" 작업이 완료되었습니다.',
    speakError: '{honorific}, "{title}" 작업을 완료하지 못했습니다.',
    errorEmptyReply:
      '응답을 받지 못했습니다(메모리 플러그인에서 거부되었거나 모델 출력이 없을 수 있음). AI 패널에서 세부 정보를 확인하세요.',
    trayButler: 'AI 집사 호출',
  },
  fr: {
    notifyDoneTitle: '{name} · Tâche terminée',
    notifyErrorTitle: '{name} · Tâche inachevée',
    notifyConfirmTitle: '{name} · Confirmation requise',
    notifyDoneBody: '{honorific}, « {title} » est terminée. {summary}',
    notifyErrorBody: '« {title} » a rencontré un problème : {error}',
    notifyConfirmBody: '« {title} » attend votre approbation : {tool}',
    speakDone: '{honorific}, « {title} » est terminée.',
    speakError: '{honorific}, « {title} » n’a pas pu être terminée.',
    errorEmptyReply:
      'Aucune réponse n’a été reçue (le greffon mémoire a peut-être refusé le tour ou le modèle n’a rien produit). Ouvrez le panneau IA pour plus de détails.',
    trayButler: 'Appeler le majordome IA',
  },
  de: {
    notifyDoneTitle: '{name} · Aufgabe erledigt',
    notifyErrorTitle: '{name} · Aufgabe nicht abgeschlossen',
    notifyConfirmTitle: '{name} · Bestätigung erforderlich',
    notifyDoneBody: '{honorific}, „{title}“ ist abgeschlossen. {summary}',
    notifyErrorBody: 'Bei „{title}“ ist ein Problem aufgetreten: {error}',
    notifyConfirmBody: '„{title}“ wartet auf Ihre Freigabe: {tool}',
    speakDone: '{honorific}, „{title}“ ist abgeschlossen.',
    speakError: '{honorific}, „{title}“ konnte nicht abgeschlossen werden.',
    errorEmptyReply:
      'Keine Antwort erhalten (das Memory-Plugin hat den Durchgang möglicherweise abgelehnt oder das Modell hat nichts ausgegeben). Öffnen Sie das KI-Panel für Details.',
    trayButler: 'KI-Butler aufrufen',
  },
  es: {
    notifyDoneTitle: '{name} · Tarea completada',
    notifyErrorTitle: '{name} · Tarea sin completar',
    notifyConfirmTitle: '{name} · Se requiere confirmación',
    notifyDoneBody: '{honorific}, «{title}» ha finalizado. {summary}',
    notifyErrorBody: '«{title}» encontró un problema: {error}',
    notifyConfirmBody: '«{title}» espera su aprobación: {tool}',
    speakDone: '{honorific}, «{title}» ha finalizado.',
    speakError: '{honorific}, no se pudo completar «{title}».',
    errorEmptyReply:
      'No se recibió ninguna respuesta (puede que el complemento de memoria haya rechazado el turno o que el modelo no haya generado nada). Abra el panel de IA para ver los detalles.',
    trayButler: 'Invocar al mayordomo IA',
  },
  th: {
    notifyDoneTitle: '{name} · งานเสร็จสิ้น',
    notifyErrorTitle: '{name} · งานไม่สำเร็จ',
    notifyConfirmTitle: '{name} · ต้องการการยืนยันจากคุณ',
    notifyDoneBody: '{honorific} งาน "{title}" เสร็จสมบูรณ์แล้ว {summary}',
    notifyErrorBody: 'งาน "{title}" พบปัญหา: {error}',
    notifyConfirmBody: 'งาน "{title}" กำลังรอการอนุมัติจากคุณ: {tool}',
    speakDone: '{honorific} งาน "{title}" เสร็จสมบูรณ์แล้ว',
    speakError: '{honorific} ไม่สามารถทำงาน "{title}" ให้เสร็จสมบูรณ์ได้',
    errorEmptyReply:
      'ไม่ได้รับคำตอบ (ปลั๊กอินหน่วยความจำอาจปฏิเสธการทำงาน หรือโมเดลไม่ส่งผลลัพธ์) โปรดเปิดแผง AI เพื่อดูรายละเอียด',
    trayButler: 'เรียกผู้ช่วย AI ส่วนตัว',
  },
  id: {
    notifyDoneTitle: '{name} · Tugas selesai',
    notifyErrorTitle: '{name} · Tugas belum selesai',
    notifyConfirmTitle: '{name} · Perlu konfirmasi Anda',
    notifyDoneBody: '{honorific}, "{title}" telah selesai. {summary}',
    notifyErrorBody: '"{title}" mengalami masalah: {error}',
    notifyConfirmBody: '"{title}" menunggu persetujuan Anda: {tool}',
    speakDone: '{honorific}, "{title}" telah selesai.',
    speakError: '{honorific}, "{title}" gagal diselesaikan.',
    errorEmptyReply:
      'Tidak ada balasan yang diterima (plugin memori mungkin menolak giliran ini atau model tidak menghasilkan apa pun). Buka panel AI untuk detailnya.',
    trayButler: 'Panggil Pelayan AI',
  },
  ru: {
    notifyDoneTitle: '{name} · Задача выполнена',
    notifyErrorTitle: '{name} · Задача не завершена',
    notifyConfirmTitle: '{name} · Требуется подтверждение',
    notifyDoneBody: '{honorific}, задача «{title}» выполнена. {summary}',
    notifyErrorBody: 'В задаче «{title}» возникла проблема: {error}',
    notifyConfirmBody: 'Задача «{title}» ожидает вашего подтверждения: {tool}',
    speakDone: '{honorific}, задача «{title}» выполнена.',
    speakError: '{honorific}, задачу «{title}» не удалось завершить.',
    errorEmptyReply:
      'Ответ не получен (плагин памяти мог отклонить запрос или модель ничего не вывела). Откройте панель ИИ для подробностей.',
    trayButler: 'Вызвать ИИ-дворецкого',
  },
  ar: {
    notifyDoneTitle: '{name} · اكتملت المهمة',
    notifyErrorTitle: '{name} · لم تكتمل المهمة',
    notifyConfirmTitle: '{name} · مطلوب تأكيدك',
    notifyDoneBody: '{honorific}، اكتملت مهمة «{title}». {summary}',
    notifyErrorBody: 'واجهت «{title}» مشكلة: {error}',
    notifyConfirmBody: 'تنتظر «{title}» موافقتك: {tool}',
    speakDone: '{honorific}، اكتملت مهمة «{title}».',
    speakError: '{honorific}، تعذّر إكمال «{title}».',
    errorEmptyReply:
      'لم يتم استلام أي رد (ربما رفض ملحق الذاكرة الدور أو لم يُخرج النموذج شيئًا). افتح لوحة الذكاء الاصطناعي للتفاصيل.',
    trayButler: 'استدعاء المساعد الشخصي',
  },
  pt: {
    notifyDoneTitle: '{name} · Tarefa concluída',
    notifyErrorTitle: '{name} · Tarefa incompleta',
    notifyConfirmTitle: '{name} · Confirmação necessária',
    notifyDoneBody: '{honorific}, "{title}" foi concluída. {summary}',
    notifyErrorBody: '"{title}" encontrou um problema: {error}',
    notifyConfirmBody: '"{title}" aguarda sua aprovação: {tool}',
    speakDone: '{honorific}, "{title}" foi concluída.',
    speakError: '{honorific}, não foi possível concluir "{title}".',
    errorEmptyReply:
      'Nenhuma resposta foi recebida (o plugin de memória pode ter recusado o turno ou o modelo não gerou nada). Abra o painel de IA para mais detalhes.',
    trayButler: 'Chamar Mordomo IA',
  },
  it: {
    notifyDoneTitle: '{name} · Attività completata',
    notifyErrorTitle: '{name} · Attività non completata',
    notifyConfirmTitle: '{name} · Conferma richiesta',
    notifyDoneBody: '{honorific}, "{title}" è stata completata. {summary}',
    notifyErrorBody: '"{title}" ha riscontrato un problema: {error}',
    notifyConfirmBody: '"{title}" è in attesa della tua approvazione: {tool}',
    speakDone: '{honorific}, "{title}" è stata completata.',
    speakError: '{honorific}, "{title}" non è stata completata.',
    errorEmptyReply:
      'Nessuna risposta ricevuta (il plugin memoria potrebbe aver rifiutato il turno o il modello non ha prodotto nulla). Apri il pannello IA per i dettagli.',
    trayButler: 'Richiama Maggiordomo IA',
  },
  pl: {
    notifyDoneTitle: '{name} · Zadanie ukończone',
    notifyErrorTitle: '{name} · Zadanie nieukończone',
    notifyConfirmTitle: '{name} · Wymagane potwierdzenie',
    notifyDoneBody: '{honorific}, zadanie „{title}” zostało ukończone. {summary}',
    notifyErrorBody: 'Zadanie „{title}” napotkało problem: {error}',
    notifyConfirmBody: 'Zadanie „{title}” oczekuje na zatwierdzenie: {tool}',
    speakDone: '{honorific}, zadanie „{title}” zostało ukończone.',
    speakError: '{honorific}, nie udało się ukończyć zadania „{title}”.',
    errorEmptyReply:
      'Nie otrzymano żadnej odpowiedzi (wtyczka pamięci mogła odrzucić turę lub model nic nie zwrócił). Otwórz panel AI, aby zobaczyć szczegóły.',
    trayButler: 'Przywołaj Lokaja AI',
  },
  cs: {
    notifyDoneTitle: '{name} · Úkol dokončen',
    notifyErrorTitle: '{name} · Úkol nedokončen',
    notifyConfirmTitle: '{name} · Vyžadováno potvrzení',
    notifyDoneBody: '{honorific}, úkol „{title}“ byl dokončen. {summary}',
    notifyErrorBody: 'Úkol „{title}“ narazil na problém: {error}',
    notifyConfirmBody: 'Úkol „{title}“ čeká na vaše schválení: {tool}',
    speakDone: '{honorific}, úkol „{title}“ byl dokončen.',
    speakError: '{honorific}, úkol „{title}“ se nepodařilo dokončit.',
    errorEmptyReply:
      'Nebyla přijata žádná odpověď (modul paměti mohl požadavek odmítnout nebo model nic nevytvořil). Podrobnosti najdete v panelu AI.',
    trayButler: 'Vyvolat AI komorníka',
  },
  nl: {
    notifyDoneTitle: '{name} · Taak voltooid',
    notifyErrorTitle: '{name} · Taak niet voltooid',
    notifyConfirmTitle: '{name} · Bevestiging vereist',
    notifyDoneBody: '{honorific}, "{title}" is voltooid. {summary}',
    notifyErrorBody: '"{title}" heeft een probleem ondervonden: {error}',
    notifyConfirmBody: '"{title}" wacht op uw goedkeuring: {tool}',
    speakDone: '{honorific}, "{title}" is voltooid.',
    speakError: '{honorific}, "{title}" kon niet worden voltooid.',
    errorEmptyReply:
      'Geen antwoord ontvangen (de geheugenplug-in heeft de beurt mogelijk geweigerd of het model heeft niets uitgevoerd). Open het AI-paneel voor details.',
    trayButler: 'AI-butler oproepen',
  },
  ms: {
    notifyDoneTitle: '{name} · Tugasan selesai',
    notifyErrorTitle: '{name} · Tugasan belum selesai',
    notifyConfirmTitle: '{name} · Pengesahan diperlukan',
    notifyDoneBody: '{honorific}, "{title}" telah selesai. {summary}',
    notifyErrorBody: '"{title}" menghadapi masalah: {error}',
    notifyConfirmBody: '"{title}" sedang menunggu kelulusan anda: {tool}',
    speakDone: '{honorific}, "{title}" telah selesai.',
    speakError: '{honorific}, "{title}" gagal diselesaikan.',
    errorEmptyReply:
      'Tiada balasan diterima (pemalam memori mungkin menolak giliran atau model tidak mengeluarkan apa-apa). Buka panel AI untuk butiran.',
    trayButler: 'Panggil Pembantu AI',
  },
  he: {
    notifyDoneTitle: '{name} · המשימה הושלמה',
    notifyErrorTitle: '{name} · המשימה לא הושלמה',
    notifyConfirmTitle: '{name} · נדרש אישורך',
    notifyDoneBody: '{honorific}, "{title}" הושלמה. {summary}',
    notifyErrorBody: '"{title}" נתקלה בבעיה: {error}',
    notifyConfirmBody: '"{title}" ממתינה לאישורך: {tool}',
    speakDone: '{honorific}, "{title}" הושלמה.',
    speakError: '{honorific}, לא ניתן היה להשלים את "{title}".',
    errorEmptyReply:
      'לא התקבלה תשובה (ייתכן שתוסף הזיכרון דחה את התור או שהמודל לא הפיק דבר). פתח את חלונית ה-AI לפרטים.',
    trayButler: 'הפעל עוזר AI אישי',
  },
  hi: {
    notifyDoneTitle: '{name} · कार्य पूर्ण',
    notifyErrorTitle: '{name} · कार्य अपूर्ण',
    notifyConfirmTitle: '{name} · आपकी पुष्टि आवश्यक है',
    notifyDoneBody: '{honorific}, "{title}" पूर्ण हो गया है। {summary}',
    notifyErrorBody: '"{title}" में समस्या आई: {error}',
    notifyConfirmBody: '"{title}" आपकी स्वीकृति की प्रतीक्षा कर रहा है: {tool}',
    speakDone: '{honorific}, "{title}" पूर्ण हो गया है।',
    speakError: '{honorific}, "{title}" पूर्ण नहीं हो सका।',
    errorEmptyReply:
      'कोई उत्तर प्राप्त नहीं हुआ (मेमोरी प्लगइन ने टर्न अस्वीकार किया हो सकता है या मॉडल ने कुछ उत्पन्न नहीं किया)। विवरण के लिए AI पैनल खोलें।',
    trayButler: 'AI बटलर बुलाएँ',
  },
  'zh-TW': {
    notifyDoneTitle: '{name} · 任務完成',
    notifyErrorTitle: '{name} · 任務未完成',
    notifyConfirmTitle: '{name} · 需要您確認',
    notifyDoneBody: '{honorific}，「{title}」已完成。{summary}',
    notifyErrorBody: '「{title}」遇到問題：{error}',
    notifyConfirmBody: '「{title}」正等待您核准：{tool}',
    speakDone: '{honorific}，「{title}」已完成。',
    speakError: '{honorific}，「{title}」未能完成。',
    errorEmptyReply: '沒有收到任何回覆，可能被記憶外掛拒絕或模型未輸出，請在 AI 面板檢視詳情',
    trayButler: '喚起 AI 管家',
  },
  vi: {
    notifyDoneTitle: '{name} · Hoàn thành tác vụ',
    notifyErrorTitle: '{name} · Tác vụ chưa hoàn thành',
    notifyConfirmTitle: '{name} · Cần bạn xác nhận',
    notifyDoneBody: '{honorific}, "{title}" đã xong. {summary}',
    notifyErrorBody: '"{title}" gặp sự cố: {error}',
    notifyConfirmBody: '"{title}" đang chờ bạn phê duyệt: {tool}',
    speakDone: '{honorific}, "{title}" đã xong.',
    speakError: '{honorific}, không thể hoàn thành "{title}".',
    errorEmptyReply:
      'Không nhận được phản hồi nào (plugin bộ nhớ có thể đã từ chối lượt hoặc mô hình không xuất gì). Mở bảng AI để xem chi tiết.',
    trayButler: 'Gọi Quản gia AI',
  },
} as const satisfies Record<Lang, Record<ButlerStringKey, string>>

const tRaw = createI18n(dicts)

/** Translate a main-process Butler notification, TTS, or tray label string. */
export function tButler(
  lang: Lang,
  key: ButlerStringKey,
  params?: Record<string, string | number>,
): string {
  return tRaw(lang, key, params)
}
