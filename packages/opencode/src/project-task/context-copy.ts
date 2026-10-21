import { parseUILocale, type UILocale } from "@opencode-ai/core/locale"

type Copy = {
  heading: string
  scope: string
  intro: string
  background: string
  preserve: string
  info: string
  task: string
  id: string
  lookup: string
  root: string
  description: string
}

const copies: Record<UILocale, Copy> = {
  en: {
    heading: "Project Task Context",
    scope: "Purpose and Scope",
    intro:
      "You are a subagent dispatched by the parent agent. Your task, scope, and deliverables are defined by the delegation prompt above.",
    background:
      "The following is shared background for the parent project, not an additional assignment. Perform only the delegated task; applicable project conventions and protection requirements still apply.",
    preserve:
      "Preserve existing changes by the user and other agents; do not overwrite their work. Report collaboration conflicts to the parent agent.",
    info: "Parent Project Task Information",
    task: "Project task",
    id: "Project task ID",
    lookup: "Use this ID when querying information about this task.",
    root: "Project root",
    description: "Parent Project Task Description",
  },
  zh: {
    heading: "项目任务上下文",
    scope: "用途与边界",
    intro: "你是主智能体派发的子智能体。本次任务、执行范围和交付要求，以上面主智能体撰写的委派 prompt 为准。",
    background:
      "以下内容是父级项目的公共背景，不是对你的额外委派。仅执行主智能体指定的任务；其中适用于本次工作的约定与保护要求仍须遵守。",
    preserve: "保留用户和其他智能体的已有改动；不要覆盖他人成果。发现协作冲突时向主智能体报告。",
    info: "父级项目任务信息",
    task: "项目任务",
    id: "项目任务 ID",
    lookup: "查询本任务相关信息时，使用此 ID",
    root: "项目根目录",
    description: "父级项目任务描述",
  },
  zht: {
    heading: "專案任務上下文",
    scope: "用途與邊界",
    intro: "你是主代理派發的子代理。本次任務、執行範圍和交付要求，以上方主代理撰寫的委派 prompt 為準。",
    background:
      "以下內容是父級專案的共同背景，不是對你的額外委派。僅執行主代理指定的任務；其中適用於本次工作的慣例與保護要求仍須遵守。",
    preserve: "保留使用者和其他代理的既有變更；不要覆蓋他人成果。發現協作衝突時向主代理回報。",
    info: "父級專案任務資訊",
    task: "專案任務",
    id: "專案任務 ID",
    lookup: "查詢本任務相關資訊時，使用此 ID",
    root: "專案根目錄",
    description: "父級專案任務描述",
  },
  ko: {
    heading: "프로젝트 작업 컨텍스트",
    scope: "목적과 범위",
    intro:
      "당신은 상위 에이전트가 위임한 하위 에이전트입니다. 작업, 실행 범위 및 결과물 요구 사항은 위의 위임 프롬프트를 따릅니다.",
    background:
      "다음은 상위 프로젝트의 공통 배경이며 추가 작업 지시가 아닙니다. 위임받은 작업만 수행하되, 해당 작업에 적용되는 프로젝트 규칙과 보호 요구 사항은 준수해야 합니다.",
    preserve:
      "사용자와 다른 에이전트의 기존 변경 사항을 보존하고 다른 사람의 작업을 덮어쓰지 마세요. 협업 충돌은 상위 에이전트에 보고하세요.",
    info: "상위 프로젝트 작업 정보",
    task: "프로젝트 작업",
    id: "프로젝트 작업 ID",
    lookup: "이 작업의 정보를 조회할 때 이 ID를 사용하세요.",
    root: "프로젝트 루트 디렉터리",
    description: "상위 프로젝트 작업 설명",
  },
  de: {
    heading: "Projektaufgabenkontext",
    scope: "Zweck und Umfang",
    intro:
      "Du bist ein vom übergeordneten Agenten beauftragter Unteragent. Deine Aufgabe, dein Arbeitsumfang und die erwarteten Ergebnisse werden durch den obigen Delegationsprompt festgelegt.",
    background:
      "Die folgenden Angaben sind gemeinsamer Hintergrund zum übergeordneten Projekt, kein zusätzlicher Auftrag. Führe nur die delegierte Aufgabe aus; geltende Projektkonventionen und Schutzanforderungen bleiben verbindlich.",
    preserve:
      "Bewahre bestehende Änderungen des Benutzers und anderer Agenten; überschreibe ihre Arbeit nicht. Melde Konflikte bei der Zusammenarbeit dem übergeordneten Agenten.",
    info: "Informationen zur übergeordneten Projektaufgabe",
    task: "Projektaufgabe",
    id: "Projektaufgaben-ID",
    lookup: "Verwende diese ID, um Informationen zu dieser Aufgabe abzufragen.",
    root: "Projektstammverzeichnis",
    description: "Beschreibung der übergeordneten Projektaufgabe",
  },
  es: {
    heading: "Contexto de la tarea del proyecto",
    scope: "Propósito y alcance",
    intro:
      "Eres un subagente enviado por el agente principal. Tu tarea, alcance y entregables se definen en el prompt de delegación anterior.",
    background:
      "Lo siguiente es contexto compartido del proyecto principal, no una asignación adicional. Ejecuta solo la tarea delegada; las convenciones y los requisitos de protección del proyecto que sean aplicables siguen siendo obligatorios.",
    preserve:
      "Conserva los cambios existentes del usuario y de otros agentes; no sobrescribas su trabajo. Informa al agente principal de cualquier conflicto de colaboración.",
    info: "Información de la tarea del proyecto principal",
    task: "Tarea del proyecto",
    id: "ID de la tarea del proyecto",
    lookup: "Usa este ID para consultar información sobre esta tarea.",
    root: "Directorio raíz del proyecto",
    description: "Descripción de la tarea del proyecto principal",
  },
  fr: {
    heading: "Contexte de la tâche du projet",
    scope: "Objectif et périmètre",
    intro:
      "Vous êtes un sous-agent mandaté par l’agent principal. Votre tâche, votre périmètre et les livrables attendus sont définis par le prompt de délégation ci-dessus.",
    background:
      "Les éléments suivants constituent le contexte commun du projet parent, et non une mission supplémentaire. Exécutez uniquement la tâche déléguée ; les conventions et exigences de protection applicables du projet restent obligatoires.",
    preserve:
      "Conservez les modifications existantes de l’utilisateur et des autres agents ; n’écrasez pas leur travail. Signalez les conflits de collaboration à l’agent principal.",
    info: "Informations sur la tâche du projet parent",
    task: "Tâche du projet",
    id: "ID de la tâche du projet",
    lookup: "Utilisez cet ID pour consulter les informations sur cette tâche.",
    root: "Répertoire racine du projet",
    description: "Description de la tâche du projet parent",
  },
  da: {
    heading: "Kontekst for projektopgaven",
    scope: "Formål og afgrænsning",
    intro:
      "Du er en underagent udsendt af hovedagenten. Din opgave, dit arbejdsomfang og de forventede leverancer er defineret i delegeringsprompten ovenfor.",
    background:
      "Det følgende er fælles baggrund for det overordnede projekt, ikke en ekstra opgave. Udfør kun den delegerede opgave; relevante projektkonventioner og beskyttelseskrav gælder stadig.",
    preserve:
      "Bevar eksisterende ændringer fra brugeren og andre agenter; overskriv ikke deres arbejde. Rapportér samarbejdskonflikter til hovedagenten.",
    info: "Oplysninger om den overordnede projektopgave",
    task: "Projektopgave",
    id: "Projektopgavens ID",
    lookup: "Brug dette ID til at hente oplysninger om denne opgave.",
    root: "Projektets rodmappe",
    description: "Beskrivelse af den overordnede projektopgave",
  },
  ja: {
    heading: "プロジェクトタスクのコンテキスト",
    scope: "用途と範囲",
    intro:
      "あなたは親エージェントから委任されたサブエージェントです。今回のタスク、実行範囲、成果物の要件は、上記の委任プロンプトに従ってください。",
    background:
      "以下は親プロジェクトの共通背景であり、追加の作業指示ではありません。委任されたタスクのみを実行し、今回の作業に適用されるプロジェクトの規約と保護要件は引き続き遵守してください。",
    preserve:
      "ユーザーや他のエージェントによる既存の変更を保持し、他者の成果を上書きしないでください。共同作業の競合は親エージェントに報告してください。",
    info: "親プロジェクトタスクの情報",
    task: "プロジェクトタスク",
    id: "プロジェクトタスク ID",
    lookup: "このタスクの情報を照会する際は、この ID を使用してください。",
    root: "プロジェクトのルートディレクトリ",
    description: "親プロジェクトタスクの説明",
  },
  pl: {
    heading: "Kontekst zadania projektu",
    scope: "Cel i zakres",
    intro:
      "Jesteś podagentem wyznaczonym przez agenta nadrzędnego. Twoje zadanie, zakres pracy i oczekiwane rezultaty określa powyższy prompt delegujący.",
    background:
      "Poniższe informacje stanowią wspólny kontekst projektu nadrzędnego, a nie dodatkowe zlecenie. Wykonuj wyłącznie delegowane zadanie; odpowiednie konwencje i wymagania ochronne projektu nadal obowiązują.",
    preserve:
      "Zachowaj istniejące zmiany użytkownika i innych agentów; nie nadpisuj ich pracy. Zgłaszaj konflikty współpracy agentowi nadrzędnemu.",
    info: "Informacje o zadaniu projektu nadrzędnego",
    task: "Zadanie projektu",
    id: "ID zadania projektu",
    lookup: "Używaj tego ID przy pobieraniu informacji o tym zadaniu.",
    root: "Katalog główny projektu",
    description: "Opis zadania projektu nadrzędnego",
  },
  ru: {
    heading: "Контекст задачи проекта",
    scope: "Назначение и границы",
    intro:
      "Вы — субагент, назначенный основным агентом. Ваша задача, границы работы и требования к результатам определяются приведённым выше промптом делегирования.",
    background:
      "Ниже приведён общий контекст родительского проекта, а не дополнительное задание. Выполняйте только делегированную задачу; применимые соглашения и требования по защите проекта остаются обязательными.",
    preserve:
      "Сохраняйте существующие изменения пользователя и других агентов; не перезаписывайте их работу. Сообщайте основному агенту о конфликтах совместной работы.",
    info: "Информация о задаче родительского проекта",
    task: "Задача проекта",
    id: "ID задачи проекта",
    lookup: "Используйте этот ID для получения информации об этой задаче.",
    root: "Корневой каталог проекта",
    description: "Описание задачи родительского проекта",
  },
  bs: {
    heading: "Kontekst projektnog zadatka",
    scope: "Svrha i opseg",
    intro:
      "Vi ste podagent kojeg je angažovao glavni agent. Vaš zadatak, opseg rada i očekivani rezultati definirani su u gornjoj uputi za delegiranje.",
    background:
      "Sljedeće informacije su zajednički kontekst nadređenog projekta, a ne dodatni zadatak. Izvršavajte samo delegirani zadatak; primjenjive projektne konvencije i zahtjevi zaštite i dalje važe.",
    preserve:
      "Sačuvajte postojeće izmjene korisnika i drugih agenata; nemojte prepisivati njihov rad. Sukobe u saradnji prijavite glavnom agentu.",
    info: "Informacije o zadatku nadređenog projekta",
    task: "Projektni zadatak",
    id: "ID projektnog zadatka",
    lookup: "Koristite ovaj ID pri traženju informacija o ovom zadatku.",
    root: "Korijenski direktorij projekta",
    description: "Opis zadatka nadređenog projekta",
  },
  ar: {
    heading: "سياق مهمة المشروع",
    scope: "الغرض والنطاق",
    intro: "أنت وكيل فرعي أرسله الوكيل الرئيسي. تُحدَّد مهمتك ونطاق عملك والمخرجات المطلوبة في نص التفويض أعلاه.",
    background:
      "ما يلي خلفية مشتركة للمشروع الرئيسي وليس تكليفًا إضافيًا. نفّذ المهمة المفوّضة فقط؛ وتظل قواعد المشروع ومتطلبات الحماية المنطبقة على عملك ملزمة.",
    preserve:
      "حافظ على التغييرات الحالية للمستخدم والوكلاء الآخرين، ولا تستبدل عملهم. أبلغ الوكيل الرئيسي بأي تعارض في التعاون.",
    info: "معلومات مهمة المشروع الرئيسي",
    task: "مهمة المشروع",
    id: "معرّف مهمة المشروع",
    lookup: "استخدم هذا المعرّف عند الاستعلام عن معلومات هذه المهمة.",
    root: "الدليل الجذري للمشروع",
    description: "وصف مهمة المشروع الرئيسي",
  },
  no: {
    heading: "Kontekst for prosjektoppgaven",
    scope: "Formål og avgrensning",
    intro:
      "Du er en underagent sendt av hovedagenten. Oppgaven din, arbeidsomfanget og kravene til leveransen er definert i delegeringsprompten ovenfor.",
    background:
      "Det følgende er felles bakgrunn for det overordnede prosjektet, ikke et ekstra oppdrag. Utfør bare den delegerte oppgaven; relevante prosjektkonvensjoner og beskyttelseskrav gjelder fortsatt.",
    preserve:
      "Bevar eksisterende endringer fra brukeren og andre agenter; ikke overskriv arbeidet deres. Rapporter samarbeidskonflikter til hovedagenten.",
    info: "Informasjon om den overordnede prosjektoppgaven",
    task: "Prosjektoppgave",
    id: "Prosjektoppgavens ID",
    lookup: "Bruk denne ID-en når du henter informasjon om denne oppgaven.",
    root: "Prosjektets rotmappe",
    description: "Beskrivelse av den overordnede prosjektoppgaven",
  },
  br: {
    heading: "Contexto da tarefa do projeto",
    scope: "Finalidade e escopo",
    intro:
      "Você é um subagente enviado pelo agente principal. Sua tarefa, escopo e entregas são definidos pelo prompt de delegação acima.",
    background:
      "O conteúdo a seguir é o contexto compartilhado do projeto principal, não uma atribuição adicional. Execute apenas a tarefa delegada; as convenções e os requisitos de proteção do projeto aplicáveis continuam obrigatórios.",
    preserve:
      "Preserve as alterações existentes do usuário e de outros agentes; não sobrescreva o trabalho deles. Informe conflitos de colaboração ao agente principal.",
    info: "Informações da tarefa do projeto principal",
    task: "Tarefa do projeto",
    id: "ID da tarefa do projeto",
    lookup: "Use este ID ao consultar informações sobre esta tarefa.",
    root: "Diretório raiz do projeto",
    description: "Descrição da tarefa do projeto principal",
  },
  th: {
    heading: "บริบทงานของโครงการ",
    scope: "วัตถุประสงค์และขอบเขต",
    intro:
      "คุณเป็นเอเจนต์ย่อยที่เอเจนต์หลักมอบหมายมา งาน ขอบเขตการดำเนินการ และข้อกำหนดของผลลัพธ์ให้ยึดตามพรอมต์การมอบหมายด้านบน",
    background:
      "เนื้อหาต่อไปนี้เป็นข้อมูลพื้นฐานร่วมของโครงการหลัก ไม่ใช่งานที่มอบหมายเพิ่มเติม ให้ดำเนินการเฉพาะงานที่ได้รับมอบหมาย โดยยังต้องปฏิบัติตามข้อตกลงและข้อกำหนดการปกป้องของโครงการที่เกี่ยวข้องกับงานนี้",
    preserve:
      "รักษาการเปลี่ยนแปลงที่มีอยู่ของผู้ใช้และเอเจนต์อื่น อย่าเขียนทับผลงานของผู้อื่น หากพบความขัดแย้งในการทำงานร่วมกัน ให้รายงานเอเจนต์หลัก",
    info: "ข้อมูลงานของโครงการหลัก",
    task: "งานของโครงการ",
    id: "ID งานของโครงการ",
    lookup: "ใช้ ID นี้เมื่อค้นหาข้อมูลเกี่ยวกับงานนี้",
    root: "ไดเรกทอรีรากของโครงการ",
    description: "คำอธิบายงานของโครงการหลัก",
  },
  tr: {
    heading: "Proje Görevi Bağlamı",
    scope: "Amaç ve Kapsam",
    intro:
      "Ana ajan tarafından görevlendirilmiş bir alt ajansınız. Göreviniz, çalışma kapsamınız ve teslim gereksinimleriniz yukarıdaki görev atama isteminde tanımlanmıştır.",
    background:
      "Aşağıdaki içerik üst projenin ortak arka planıdır, ek bir görev değildir. Yalnızca size devredilen görevi yerine getirin; işinize uygulanabilir proje kuralları ve koruma gereksinimleri geçerliliğini korur.",
    preserve:
      "Kullanıcının ve diğer ajanların mevcut değişikliklerini koruyun; çalışmalarının üzerine yazmayın. İş birliği çakışmalarını ana ajana bildirin.",
    info: "Üst Proje Görevi Bilgileri",
    task: "Proje görevi",
    id: "Proje görevi ID",
    lookup: "Bu görevle ilgili bilgi sorgularken bu ID'yi kullanın.",
    root: "Proje kök dizini",
    description: "Üst Proje Görevi Açıklaması",
  },
}

export function projectTaskContextCopy(locale?: string): Copy {
  return copies[parseUILocale(locale) ?? "en"]
}
