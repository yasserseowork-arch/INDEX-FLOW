// src/types/state.ts
var SCHEMA_VERSION = 5;
var STORAGE_KEY = "gscBulkIndexer.state";
var DEFAULT_OPERATION_DELAY_SECONDS = 10;
var DEFAULT_LIMIT_DELAY_SECONDS = 30 * 60;
var DEFAULT_SETTINGS = {
  sitemapUrl: "",
  indexMode: "both",
  delaySeconds: DEFAULT_OPERATION_DELAY_SECONDS,
  limitDelaySeconds: DEFAULT_LIMIT_DELAY_SECONDS
};
var EMPTY_STATS = {
  total: 0,
  pending: 0,
  processing: 0,
  requested: 0,
  skipped: 0,
  quotaBlocked: 0,
  errors: 0
};
function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    runState: { status: "idle", stopRequested: false },
    queue: [],
    processedUrls: {},
    stats: { ...EMPTY_STATS },
    logs: [],
    quotaBlocks: {},
    auth: { panelOpenCount: 0 }
  };
}
function computeStats(queue) {
  const stats = { ...EMPTY_STATS, total: queue.length };
  for (const item of queue) {
    switch (item.status) {
      case "pending":
        stats.pending += 1;
        break;
      case "processing":
        stats.processing += 1;
        break;
      case "request_sent":
        stats.requested += 1;
        break;
      case "skipped_mode":
        stats.skipped += 1;
        break;
      case "quota_blocked":
        stats.quotaBlocked += 1;
        break;
      case "error":
        stats.errors += 1;
        break;
    }
  }
  return stats;
}

// src/ui/side-panel.ts
var PAGE_SIZE = 10;

var isExtensionContext = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
var state = createDefaultState();
var busyAction = null;
var queuePage = 1;
var toastTimeout;
var lastProcessingItemId;
var dictionary = {};
var fallbackDictionary = {
  "appTitle": "الفهرسة الجماعية لروابط جوجل — IndexFlow",
  "brandEyebrow": "IndexFlow · أدوات GSC",
  "appHeading": "الفهرسة المجمّعة",
  "wizardSource": "الرابط",
  "wizardRules": "التحميل",
  "wizardRun": "الإعدادات",
  "wizardIndexing": "الفهرسة",
  "back": "رجوع",
  "next": "التالي",
  "continueToRules": "المتابعة إلى القواعد",
  "continueToRun": "المتابعة إلى التشغيل",
  "continueToLoad": "تحميل الخريطة",
  "continueToSettings": "الإعدادات",
  "sourceStep": "01 · الرابط",
  "loadStep": "02 · التحميل",
  "loadTitle": "أضف رابط السايت ماب",
  "loadDescription": "أضف خريطة موقع. سيجد IndexFlow الروابط ويحذف المكرر.",
  "sitemapLabel": "رابط خريطة الموقع",
  "sitemapPlaceholder": "https://example.com/sitemap.xml",
  "loadButton": "تحميل",
  "sitemapHint": "يدعم XML وفهارس الخرائط وملفات gzip.",
  "sitemapReady": "خريطة الموقع جاهزة",
  "sitemapReadyCount": "{count} رابط جاهز",
  "documentsScanned": "تم فحص {count} مستند خريطة موقع",
  "found": "تم العثور",
  "queued": "في الطابور",
  "history": "السجل",
  "duplicates": "المكررات",
  "childFailures": "فشل {count} من الخرائط الفرعية. باقي الروابط جاهزة.",
  "rulesStep": "03 · الإعدادات",
  "rulesTitle": "اختر الصفحات",
  "indexModeLegend": "وضع الفهرسة",
  "newTitle": "الجديدة فقط",
  "newDescription": "أرسل الصفحات غير المفهرسة في Google.",
  "reindexTitle": "إعادة الفهرسة",
  "reindexDescription": "حدّث الصفحات الموجودة على Google.",
  "bothTitle": "كلاهما",
  "bothDescription": "أرسل الصفحات الجديدة والمفهرسة.",
  "delayLabel": "التأخير بين الروابط",
  "delayHint": "انتظر بين طلبات Search Console.",
  "timingTitle": "مواعيد التشغيل التلقائي",
  "skipDelayNote": "عند تخطي الرابط: انتظار 10 ثوانٍ فقط قبل الرابط التالي.",
  "successReturnNote": "بعد نجاح الطلب: الرجوع إلى صفحة Search Console الرئيسية قبل الرابط التالي.",
  "seconds": "ثانية",
  "runStep": "04 · الفهرسة",
  "runTitle": "جاهز",
  "runLoadHint": "حمّل خريطة موقع لإنشاء الطابور.",
  "startQueue": "بدء الطابور",
  "stop": "إيقاف",
  "reset": "إعادة ضبط",
  "liveOverview": "نظرة مباشرة",
  "queueProgress": "تقدم الطابور",
  "pending": "قيد الانتظار",
  "processing": "قيد المعالجة",
  "requested": "تم الطلب",
  "skipped": "تم التخطي",
  "errors": "الأخطاء",
  "quotaBlocked": "محظور بالحصة",
  "noUrlsLoaded": "لم يتم تحميل روابط",
  "urlDetails": "تفاصيل الروابط",
  "queue": "الطابور",
  "searchQueue": "البحث في الطابور",
  "searchPlaceholder": "البحث عن رابط",
  "filterStatus": "تصفية حسب الحالة",
  "allStatuses": "كل الحالات",
  "queueEmptyTitle": "الطابور فارغ",
  "queueEmptyBody": "حمّل خريطة موقع لاكتشاف الروابط.",
  "diagnostics": "التشخيص",
  "activity": "النشاط",
  "copyLog": "نسخ سجل النشاط",
  "clearLog": "مسح النشاط",
  "logEmpty": "سيظهر النشاط هنا أثناء عملك.",
  "copyright": "© 2026 IndexFlow. جميع الحقوق محفوظة.",
  "resetTitle": "إعادة ضبط كل شيء؟",
  "resetBody": "سيؤدي هذا إلى مسح الطابور وسجل المعالجة والإعدادات والنشاط وبيانات الحصة. ستبقى اللغة كما هي.",
  "cancel": "إلغاء",
  "resetAll": "مسح كل البيانات",
  "statusIdle": "خامل",
  "statusRunning": "قيد التشغيل",
  "statusStopping": "جارٍ الإيقاف",
  "statusStopped": "متوقف",
  "statusCompleted": "مكتمل",
  "gscNewPage": "صفحة جديدة",
  "gscOnGoogle": "على Google",
  "gscUnknown": "غير معروف",
  "runInspecting": "جارٍ فحص {url}",
  "runPreparing": "جارٍ تجهيز الرابط التالي...",
  "waitNormalReason": "انتظار دقيقة قبل الرابط التالي",
  "waitSkippedReason": "تم تخطي الرابط — انتظار 10 ثوانٍ",
  "waitQuotaReason": "تم الوصول للـ Limit — إعادة المحاولة خلال 5 دقائق",
  "nextOperationAt": "موعد العملية التالية: {time}",
  "runStopping": "انتظار نقطة إيقاف آمنة...",
  "runComplete": "اكتملت كل الروابط المؤهلة في هذا الطابور.",
  "runUrlsReady": "{count} رابط جاهز للمعالجة.",
  "runQuotaWaiting": "{count} رابط ينتظر انتهاء فترة الحصة.",
  "progressFinished": "اكتمل {finished} من {total}",
  "queueCount": "{count} رابط",
  "pageOf": "الصفحة {page} من {pages}",
  "attempt": "المحاولة {count}",
  "waiting": "انتظار",
  "previousPage": "صفحة الطابور السابقة",
  "nextPage": "صفحة الطابور التالية",
  "actionFailed": "تعذر على الإضافة إكمال هذا الإجراء.",
  "invalidSitemap": "أدخل رابط HTTP(S) كاملًا لخريطة الموقع.",
  "sitemapLoaded": "تم تحميل خريطة الموقع",
  "delayError": "أدخل عدد ثوانٍ صحيحًا (10 ثوانٍ على الأقل).",
  "queueStarted": "بدأ الطابور",
  "stopRequested": "تم طلب الإيقاف",
  "allDataReset": "تمت إعادة ضبط البيانات مع الاحتفاظ باللغة.",
  "activityCopied": "تم نسخ النشاط",
  "copyFailed": "تعذر نسخ النشاط",
  "activityCleared": "تم مسح النشاط",
  "conversionLoadingTitle": "جارٍ قراءة السايت ماب",
  "conversionLoadingBody": "جارٍ جمع الروابط وحذف المكرر...",
  "conversionSuccessTitle": "السايت ماب جاهز",
  "conversionSuccessBody": "الروابط جاهزة. افتح الإعدادات للمتابعة.",
  "conversionErrorTitle": "تعذر تحميل السايت ماب",
  "conversionErrorBody": "راجع الرابط وحاول مرة أخرى.",
  "retry": "إعادة المحاولة",
  "loadSitemapButton": "تحميل Sitemap",
  "sourceIntro": "ارفع ملف روابط أو الصق الروابط مباشرة، أو استخدم ملف Sitemap.",
  "directUrlsLabel": "روابط مباشرة",
  "directUrlsPlaceholder": "https://example.com/page-1\nhttps://example.com/page-2",
  "loadDirectUrlsButton": "تحميل الروابط",
  "uploadFileButton": "رفع ملف",
  "directUrlsHint": "TXT أو CSV أو JSON — رابط واحد في كل سطر.",
  "noDirectUrlsFound": "لم يتم العثور على روابط صالحة",
  "directUrlsAdded": "تمت إضافة الروابط",
  "indexDelayLabel": "الانتظار بين عمليات الفهرسة (ثوانٍ)",
  "indexDelayHint": "بالثواني — الانتظار قبل معالجة الرابط التالي.",
  "limitDelayLabel": "الانتظار بعد بلوغ الحد (ثوانٍ)",
  "limitDelayHint": "بالثواني — الانتظار قبل إعادة المحاولة بعد تجاوز الحد / الحصة.",
  "customIndexDelayNote": "العمليات الناجحة والفاشلة تستخدم مدة انتظار الفهرسة التي حددتها.",
  "customLimitDelayNote": "عند تجاوز الحد / الحصة يتم استخدام مدة انتظار الحد، ثم إعادة المحاولة تلقائياً.",
  "waitCustomIndexReason": "انتظار قبل الرابط التالي",
  "waitCustomLimitReason": "تم بلوغ الحد — جارٍ الانتظار لإعادة المحاولة",
  "directSuccessTitle": "الروابط جاهزة",
  "directLinksMeta": "روابط مضافة مباشرة — بدون فحص خريطة موقع"
};
var activeLanguage = "ar";
var languageReady = false;
var wizardStep = 1;
var wizardDirection = "forward";
var lastRenderedWizardStep = 0;
var conversionStatus = "idle";
var conversionSource = "sitemap";
var conversionError = "";
var sitemapAutoLoadTimer;
function element(id) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element #${id}`);
  return found;
}
var ui = {
  wizardProgress: element("wizardProgress"),
  wizardControls: element("wizardControls"),
  wizardBackButton: element("wizardBackButton"),
  wizardNextButton: element("wizardNextButton"),
  wizardNextText: element("wizardNextText"),
  runPill: element("runPill"),
  runStatusText: element("runStatusText"),
  headerPill: element("headerPill"),
  headerStatusText: element("headerStatusText"),
  headerQueueCount: element("headerQueueCount"),
  runElapsed: element("runElapsed"),
  sitemapForm: element("sitemapForm"),
  directUrls: element("directUrls"),
  directFile: element("directFile"),
  directFileName: element("directFileName"),
  loadDirectUrls: element("loadDirectUrls"),
  loadSitemapButton: element("loadSitemapButton"),
  sitemapUrl: element("sitemapUrl"),
  formError: element("formError"),
  conversionCard: element("conversionCard"),
  conversionIcon: element("conversionIcon"),
  conversionTitle: element("conversionTitle"),
  conversionBody: element("conversionBody"),
  retryConversionButton: element("retryConversionButton"),
  discoverySummary: element("discoverySummary"),
  discoveryHeadline: element("discoveryHeadline"),
  discoveryMeta: element("discoveryMeta"),
  discoveryMetrics: element("discoveryMetrics"),
  discoveryWarning: element("discoveryWarning"),
  indexModeFieldset: element("indexModeFieldset"),
  indexDelaySeconds: element("indexDelaySeconds"),
  startButton: element("startButton"),
  stopButton: element("stopButton"),
  resetButton: element("resetButton"),
  runHelper: element("runHelper"),
  waitProgress: element("waitProgress"),
  waitReason: element("waitReason"),
  waitCountdown: element("waitCountdown"),
  waitProgressBar: element("waitProgressBar"),
  waitProgressFill: element("waitProgressFill"),
  waitNextAt: element("waitNextAt"),
  pendingCount: element("pendingCount"),
  processingCount: element("processingCount"),
  requestedCount: element("requestedCount"),
  skippedCount: element("skippedCount"),
  errorCount: element("errorCount"),
  progressLabel: element("progressLabel"),
  progressPercent: element("progressPercent"),
  progressBar: element("progressBar"),
  progressFill: element("progressFill"),
  queueTotalBadge: element("queueTotalBadge"),
  exportCsvButton: element("exportCsvButton"),
  quotaDialog: element("quotaDialog"),
  quotaDialogClose: element("quotaDialogClose"),
  completionDialog: element("completionDialog"),
  completionDialogClose: element("completionDialogClose"),
  aboutDialog: element("aboutDialog"),
  aboutAvatar: element("aboutAvatar"),
  aboutClose: element("aboutClose"),
  aboutButton: element("aboutButton"),
  brandAvatar: element("brandAvatar"),
  queueSearch: element("queueSearch"),
  queueFilter: element("queueFilter"),
  queueList: element("queueList"),
  queueEmpty: element("queueEmpty"),
  pagination: element("pagination"),
  previousPage: element("previousPage"),
  nextPage: element("nextPage"),
  pageLabel: element("pageLabel"),
  activityLog: element("activityLog"),
  logEmpty: element("logEmpty"),
  copyLogsButton: element("copyLogsButton"),
  clearLogsButton: element("clearLogsButton"),
  resetDialog: element("resetDialog"),
  toast: element("toast")
};
function makePreviewState() {
  const preview = createDefaultState();
  preview.settings = {
    sitemapUrl: "https://example.com/sitemap_index.xml",
    indexMode: "both",
    delaySeconds: DEFAULT_OPERATION_DELAY_SECONDS,
    limitDelaySeconds: DEFAULT_LIMIT_DELAY_SECONDS,
    language: "auto"
  };
  preview.runState = { status: "running", runId: "preview", stopRequested: false, currentItemId: "preview-2", startedAt: Date.now() - 92e3 };
  const statuses = ["request_sent", "processing", "pending", "pending", "skipped_mode", "error"];
  preview.queue = statuses.map((status, index) => ({
    id: `preview-${index + 1}`,
    url: `https://example.com/${["guides/getting-started", "blog/technical-seo", "products/site-audit", "resources/checklist", "about", "archive/old-page"][index] ?? index}`,
    normalizedUrl: `https://example.com/page-${index}`,
    status,
    gscPageStatus: index === 0 || index === 4 ? "indexed_page" : index === 1 ? "new_page" : "unknown",
    outcome: status === "request_sent" ? "Indexing request accepted" : status === "skipped_mode" ? "Skipped by New only mode" : status === "error" ? "Inspection timed out" : void 0,
    attemptCount: status === "pending" ? 0 : 1,
    createdAt: Date.now() - (index + 1) * 45e3,
    startedAt: status === "processing" ? Date.now() - 8e3 : void 0,
    finishedAt: status !== "pending" && status !== "processing" ? Date.now() - index * 12e3 : void 0
  }));
  preview.stats = computeStats(preview.queue);
  preview.discovery = {
    sourceUrl: preview.settings.sitemapUrl,
    sitemapCount: 8,
    discoveredCount: 246,
    duplicateCount: 12,
    historySkippedCount: 31,
    invalidCount: 0,
    queuedCount: preview.queue.length,
    failures: [],
    loadedAt: Date.now()
  };
  preview.logs = [
    { id: "l1", timestamp: Date.now() - 8e4, level: "success", message: "تم تحميل خريطة الموقع: 203 رابطًا في الطابور، 31 طُلبت سابقًا، 12 مكررًا." },
    { id: "l2", timestamp: Date.now() - 32e3, level: "info", message: "بدأ الطابور بـ 203 رابطًا في الانتظار." },
    { id: "l3", timestamp: Date.now() - 8e3, level: "info", message: "جارٍ فحص https://example.com/blog/technical-seo" }
  ];
  return preview;
}
async function send(message) {
  if (!isExtensionContext) return { success: true, state };
  return chrome.runtime.sendMessage(message);
}
function localeUrl() {
  const relative = "i18n/ar.json";
  return isExtensionContext ? chrome.runtime.getURL(relative) : new URL(relative, document.baseURI).toString();
}
async function loadDictionary() {
  const response = await fetch(localeUrl());
  if (!response.ok) throw new Error("تعذر تحميل ملف الترجمة العربية.");
  return response.json();
}
function t(key, replacements = {}) {
  const template = dictionary[key] ?? fallbackDictionary[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name) => String(replacements[name] ?? `{${name}}`));
}
function applyTranslations() {
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
  document.title = t("appTitle");
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
  for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder;
    if (key) node.setAttribute("placeholder", t(key));
  }
  ui.previousPage.setAttribute("aria-label", t("previousPage"));
  ui.nextPage.setAttribute("aria-label", t("nextPage"));
  ui.copyLogsButton.setAttribute("aria-label", t("copyLog"));
  ui.copyLogsButton.title = t("copyLog");
  ui.clearLogsButton.setAttribute("aria-label", t("clearLog"));
  ui.clearLogsButton.title = t("clearLog");
  ui.exportCsvButton.setAttribute("aria-label", t("exportCsv"));
  ui.exportCsvButton.title = t("exportCsv");
  ui.aboutButton.setAttribute("aria-label", t("aboutButton"));
  ui.aboutButton.title = t("aboutButton");
}
async function initLanguage() {
  if (languageReady) return;
  try {
    dictionary = await loadDictionary();
  } catch (error) {
    console.error(error);
  }
  languageReady = true;
  applyTranslations();
  render();
}
function flyAvatarHome() {
  const dialog = ui.aboutDialog;
  const avatar = ui.aboutAvatar;
  const target = ui.brandAvatar;
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !avatar || !target) {
    dialog.close();
    return;
  }
  const from = avatar.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  dialog.close();
  if (from.width === 0 || to.width === 0) return;
  const clone = avatar.cloneNode(false);
  clone.removeAttribute("id");
  clone.className = "about-fly-avatar";
  clone.style.position = "fixed";
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  clone.style.width = `${from.width}px`;
  clone.style.height = `${from.height}px`;
  clone.style.margin = "0";
  clone.style.zIndex = "99";
  clone.style.pointerEvents = "none";
  document.body.append(clone);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scale = to.width / from.width;
  const lift = 42;
  const animation = clone.animate([
    { transform: "translate(0px, 0px) scale(1) rotate(0deg)" },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - lift}px) scale(${(1 + scale) / 2}) rotate(-4deg)`, offset: 0.55 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(-9deg)` }
  ], { duration: 500, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" });
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clone.remove();
    try {
      target.animate([{ transform: "scale(1.14)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    } catch {
    }
  };
  animation.onfinish = settle;
  animation.oncancel = settle;
  const onHidden = () => {
    if (document.hidden) {
      try {
        animation.cancel();
      } catch {
      }
      settle();
    }
  };
  document.addEventListener("visibilitychange", onHidden, { once: true });
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", onHidden);
    settle();
  }, 950);
}
function showToast(message, level = "normal") {
  window.clearTimeout(toastTimeout);
  ui.toast.textContent = message;
  ui.toast.className = `toast visible${level === "error" ? " error" : ""}`;
  toastTimeout = window.setTimeout(() => {
    ui.toast.className = "toast";
  }, 3200);
}
function setFormError(message = "") {
  ui.formError.textContent = message;
}
function setBusy(action) {
  busyAction = action;
  renderControls();
}
function runStatusLabel(status) {
  const keys = {
    idle: "statusIdle",
    running: "statusRunning",
    stopping: "statusStopping",
    stopped: "statusStopped",
    completed: "statusCompleted"
  };
  return t(keys[status]);
}
function statusLabel(status) {
  const keys = {
    pending: "pending",
    processing: "processing",
    request_sent: "requested",
    skipped_mode: "skipped",
    quota_blocked: "quotaBlocked",
    error: "errors"
  };
  return t(keys[status]);
}
function gscStatusLabel(status) {
  if (status === "new_page") return t("gscNewPage");
  if (status === "indexed_page") return t("gscOnGoogle");
  return t("gscUnknown");
}
function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat(activeLanguage, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}
function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1e3));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function formatClockDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1e3));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
var lastWaitSig = "";
function renderWaitProgress() {
  const wait = state.runState.wait;
  const now = Date.now();
  const active = state.runState.status === "running" && wait !== void 0 && wait.until > now;
  const countdown = active ? formatCountdown(wait.until - now) : "";
  const duration = active ? Math.max(1, wait.until - wait.startedAt) : 1;
  const percent = active ? Math.round(Math.min(duration, Math.max(0, now - wait.startedAt)) / duration * 100) : 0;
  const elapsedActive = (state.runState.status === "running" || state.runState.status === "stopping") && Number.isFinite(state.runState.startedAt);
  const elapsedText = elapsedActive ? formatClockDuration(now - state.runState.startedAt) : "";
  const headerText = active ? t("headerWaiting", { time: countdown }) : runStatusLabel(state.runState.status);
  const sig = [state.runState.status, active, countdown, percent, elapsedText, headerText].join("|");
  if (sig === lastWaitSig) return;
  lastWaitSig = sig;
  ui.waitProgress.hidden = !active;
  renderRunElapsed();
  ui.headerStatusText.textContent = headerText;
  if (!active || !wait) return;
  const reason = wait.reason === "quota" ? t("waitCustomLimitReason") : wait.reason === "skipped" ? t("waitSkippedReason") : t("waitCustomIndexReason");
  ui.waitProgress.dataset.reason = wait.reason;
  ui.waitReason.textContent = reason;
  ui.waitCountdown.textContent = countdown;
  ui.waitProgressFill.style.width = `${percent}%`;
  ui.waitProgressBar.setAttribute("aria-label", reason);
  ui.waitProgressBar.setAttribute("aria-valuenow", String(percent));
  ui.waitProgressBar.setAttribute("aria-valuetext", countdown);
  ui.waitNextAt.textContent = t("nextOperationAt", { time: formatTime(wait.until) });
}
function renderRunElapsed() {
  const runState = state.runState;
  const active = (runState.status === "running" || runState.status === "stopping") && Number.isFinite(runState.startedAt);
  ui.runElapsed.hidden = !active;
  if (active) ui.runElapsed.textContent = t("runElapsed", { time: formatClockDuration(Date.now() - runState.startedAt) });
}
function renderHeader() {
  ui.runPill.dataset.status = state.runState.status;
  ui.runStatusText.textContent = runStatusLabel(state.runState.status);
  ui.headerPill.dataset.status = state.runState.status;
  ui.headerStatusText.textContent = runStatusLabel(state.runState.status);
  const total = state.stats.total;
  ui.headerQueueCount.hidden = total === 0;
  if (total > 0) ui.headerQueueCount.textContent = t("queueCount", { count: total.toLocaleString(activeLanguage) });
}
function setWizardStep(step) {
  if (step < 1 || step > 4) return;
  if (step === 2 && conversionStatus === "idle") return;
  if (step >= 3 && !state.discovery) return;
  wizardDirection = step > wizardStep ? "forward" : "back";
  wizardStep = step;
  renderWizard();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function backToSourceStep() {
  if (state.runState.status === "running" || state.runState.status === "stopping") {
    showToast(t("stopBeforeSourceReset"), "error");
    return;
  }
  wizardDirection = "back";
  wizardStep = 1;
  conversionStatus = "idle";
  conversionError = "";
  ui.directUrls.value = "";
  ui.directFile.value = "";
  ui.directFileName.hidden = true;
  ui.directFileName.textContent = "";
  try {
    await applyResponse(await send({ type: "RESET_SOURCE" }), t("sourceResetDone"));
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    render();
  }
}
function goBackOneStep() {
  if (wizardStep === 1) return;
  if (wizardStep === 2) {
    void backToSourceStep();
    return;
  }
  if (conversionStatus === "idle" && state.discovery) conversionStatus = "success";
  wizardDirection = "back";
  wizardStep = wizardStep - 1;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function renderWizard() {
  const stepChanged = lastRenderedWizardStep !== wizardStep;
  for (const panel of document.querySelectorAll("[data-wizard-step]")) {
    const isCurrent = Number(panel.dataset.wizardStep) === wizardStep;
    panel.hidden = !isCurrent;
    panel.classList.remove("slide-forward", "slide-back");
    if (isCurrent && stepChanged) {
      void panel.offsetWidth;
      panel.classList.add(wizardDirection === "forward" ? "slide-forward" : "slide-back");
    }
  }
  for (const button of ui.wizardProgress.querySelectorAll(".wizard-step")) {
    const step = Number(button.dataset.step);
    button.classList.toggle("active", step === wizardStep);
    button.classList.toggle("complete", step < wizardStep);
    button.disabled = step === 2 ? conversionStatus === "idle" : step >= 3 ? !state.discovery : false;
    if (step === wizardStep) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
  lastRenderedWizardStep = wizardStep;
  ui.wizardBackButton.hidden = wizardStep === 1;
  ui.wizardNextButton.hidden = wizardStep === 1 || wizardStep === 4;
  ui.wizardNextButton.disabled = busyAction !== null || wizardStep === 2 && conversionStatus !== "success";
  const hasSitemapValue = Boolean(ui.sitemapUrl.value.trim());
  const hasDirectValue = parseDirectLinks(ui.directUrls.value).length > 0;
  const stepOneLabel = hasSitemapValue && hasDirectValue ? t("loadAll") : hasSitemapValue ? t("continueToLoad") : hasDirectValue ? t("loadDirectUrlsButton") : t("continueToLoad");
  ui.wizardNextText.textContent = wizardStep === 1 ? stepOneLabel : wizardStep === 2 ? t("continueToSettings") : t("next");
}
function renderConversion() {
  ui.conversionCard.dataset.status = conversionStatus;
  ui.conversionIcon.classList.toggle("spinning", conversionStatus === "loading");
  ui.retryConversionButton.hidden = conversionStatus !== "error";
  ui.retryConversionButton.disabled = busyAction !== null;
  if (conversionStatus === "success") {
    ui.conversionTitle.textContent = state.discovery?.sourceUrl === "direct-links" ? t("directSuccessTitle") : t("conversionSuccessTitle");
    ui.conversionBody.textContent = t("conversionSuccessBody");
  } else if (conversionStatus === "error") {
    ui.conversionTitle.textContent = t("conversionErrorTitle");
    ui.conversionBody.textContent = conversionError || t("conversionErrorBody");
  } else if (conversionSource === "direct") {
    ui.conversionTitle.textContent = t("directLoadingTitle");
    ui.conversionBody.textContent = t("directLoadingBody");
  } else {
    ui.conversionTitle.textContent = t("conversionLoadingTitle");
    ui.conversionBody.textContent = t("conversionLoadingBody");
  }
}
function renderDiscovery() {
  const discovery = state.discovery;
  ui.discoverySummary.hidden = !discovery || conversionStatus !== "success";
  if (!discovery) return;
  ui.discoveryHeadline.textContent = t("sitemapReadyCount", { count: discovery.queuedCount.toLocaleString(activeLanguage) });
  ui.discoveryMeta.textContent = discovery.sourceUrl === "direct-links" ? t("directLinksMeta") : t("documentsScanned", { count: discovery.sitemapCount.toLocaleString(activeLanguage) });
  ui.discoveryMetrics.replaceChildren();
  const metrics = [
    ["found", discovery.discoveredCount],
    ["queued", discovery.queuedCount],
    ["history", discovery.historySkippedCount],
    ["duplicates", discovery.duplicateCount]
  ];
  for (const [key, value] of metrics) {
    const chip = document.createElement("span");
    chip.className = "metric-chip";
    const strong = document.createElement("strong");
    strong.textContent = value.toLocaleString(activeLanguage);
    chip.append(strong, ` ${t(key)}`);
    ui.discoveryMetrics.append(chip);
  }
  const warningCount = discovery.failures.length;
  ui.discoveryWarning.hidden = warningCount === 0;
  ui.discoveryWarning.textContent = warningCount > 0 ? t("childFailures", { count: warningCount.toLocaleString(activeLanguage) }) : "";
}
function renderSettings() {
  if (document.activeElement !== ui.sitemapUrl) ui.sitemapUrl.value = state.settings.sitemapUrl;
  for (const input of document.querySelectorAll('input[name="indexMode"]')) {
    input.checked = input.value === state.settings.indexMode;
  }
  if (document.activeElement !== ui.indexDelaySeconds) ui.indexDelaySeconds.value = String(state.settings.delaySeconds);
}
function renderControls() {
  const running = state.runState.status === "running" || state.runState.status === "stopping";
  const pending = state.stats.pending;
  const disabled = busyAction !== null;
  ui.sitemapUrl.disabled = disabled;
  ui.indexModeFieldset.disabled = running || disabled;
  ui.indexDelaySeconds.disabled = running || disabled;
  ui.startButton.disabled = running || pending === 0 || disabled;
  ui.stopButton.disabled = !running || state.runState.status === "stopping" || disabled;
  ui.resetButton.disabled = disabled;
  ui.clearLogsButton.disabled = state.logs.length === 0 || disabled;
  ui.copyLogsButton.disabled = state.logs.length === 0;
  ui.exportCsvButton.disabled = state.stats.total === 0;
  if (state.runState.status === "running") {
    const current = state.queue.find((item) => item.status === "processing");
    ui.runHelper.textContent = current ? t("runInspecting", { url: current.url }) : t("runPreparing");
  } else if (state.runState.status === "stopping") {
    ui.runHelper.textContent = t("runStopping");
  } else if (state.runState.status === "completed") {
    ui.runHelper.textContent = t("runComplete");
  } else if (pending > 0) {
    ui.runHelper.textContent = t("runUrlsReady", { count: pending.toLocaleString(activeLanguage) });
  } else if (state.stats.quotaBlocked > 0) {
    ui.runHelper.textContent = t("runQuotaWaiting", { count: state.stats.quotaBlocked.toLocaleString(activeLanguage) });
  } else {
    ui.runHelper.textContent = t("runLoadHint");
  }
}
function renderStats() {
  ui.pendingCount.textContent = (state.stats.pending + state.stats.quotaBlocked).toLocaleString(activeLanguage);
  ui.processingCount.textContent = state.stats.processing.toLocaleString(activeLanguage);
  ui.requestedCount.textContent = state.stats.requested.toLocaleString(activeLanguage);
  ui.skippedCount.textContent = state.stats.skipped.toLocaleString(activeLanguage);
  ui.errorCount.textContent = state.stats.errors.toLocaleString(activeLanguage);
  const terminal = state.stats.requested + state.stats.skipped + state.stats.errors;
  const percent = state.stats.total === 0 ? 0 : Math.round(terminal / state.stats.total * 100);
  ui.progressLabel.textContent = state.stats.total === 0 ? t("noUrlsLoaded") : t("progressFinished", {
    finished: terminal.toLocaleString(activeLanguage),
    total: state.stats.total.toLocaleString(activeLanguage)
  });
  ui.progressPercent.textContent = `${percent.toLocaleString(activeLanguage)}%`;
  ui.progressFill.style.width = `${percent}%`;
  ui.progressBar.setAttribute("aria-valuenow", String(percent));
}
function filteredQueue() {
  const search = ui.queueSearch.value.trim().toLowerCase();
  const filter = ui.queueFilter.value;
  return state.queue.filter((item) => {
    const matchesSearch = !search || item.url.toLowerCase().includes(search) || (item.outcome ?? "").toLowerCase().includes(search);
    const matchesStatus = filter === "all" || item.status === filter;
    return matchesSearch && matchesStatus;
  });
}
function createQueueRow(item, absoluteIndex) {
  const row = document.createElement("article");
  row.className = "queue-item";
  row.dataset.status = item.status;
  row.dataset.itemId = item.id;
  const index = document.createElement("span");
  index.className = "queue-index";
  index.textContent = item.status === "processing" ? "\u25B6" : String(absoluteIndex + 1);
  const copy = document.createElement("div");
  copy.className = "queue-copy";
  const url = document.createElement("span");
  url.className = "queue-url";
  const term = ui.queueSearch.value.trim().toLowerCase();
  const termIndex = term ? item.url.toLowerCase().indexOf(term) : -1;
  if (termIndex === -1) {
    url.textContent = item.url;
  } else {
    const lower = item.url.toLowerCase();
    let cursor = 0;
    let idx = termIndex;
    while (idx !== -1) {
      if (idx > cursor) url.append(document.createTextNode(item.url.slice(cursor, idx)));
      const mark = document.createElement("mark");
      mark.textContent = item.url.slice(idx, idx + term.length);
      url.append(mark);
      cursor = idx + term.length;
      idx = lower.indexOf(term, cursor);
    }
    if (cursor < item.url.length) url.append(document.createTextNode(item.url.slice(cursor)));
  }
  url.title = item.url;
  const meta = document.createElement("div");
  meta.className = "queue-meta";
  const time = document.createElement("span");
  time.textContent = formatTime(item.finishedAt ?? item.startedAt ?? item.createdAt);
  const outcome = document.createElement("span");
  outcome.className = "queue-outcome";
  outcome.textContent = item.outcome ?? (item.attemptCount ? t("attempt", { count: item.attemptCount }) : t("waiting"));
  outcome.title = item.outcome ?? "";
  meta.append(time, outcome);
  copy.append(url, meta);
  const badges = document.createElement("div");
  badges.className = "status-stack";
  const status = document.createElement("span");
  status.className = `status-badge ${item.status}`;
  status.textContent = statusLabel(item.status);
  badges.append(status);
  if (item.gscPageStatus !== "unknown") {
    const page = document.createElement("span");
    page.className = "page-badge";
    page.textContent = gscStatusLabel(item.gscPageStatus);
    badges.append(page);
  }
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "icon-button row-copy";
  copyBtn.setAttribute("aria-label", t("copyUrl"));
  copyBtn.title = t("copyUrl");
  copyBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(item.url).then(() => showToast(t("urlCopied")), () => showToast(t("copyFailed"), "error"));
  });
  badges.append(copyBtn);
  row.append(index, copy, badges);
  return row;
}
function renderQueue() {
  const items = filteredQueue();
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  queuePage = Math.min(queuePage, pages);
  const start = (queuePage - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);
  ui.queueTotalBadge.textContent = t("queueCount", { count: state.queue.length.toLocaleString(activeLanguage) });
  ui.queueList.replaceChildren(...pageItems.map((item, index) => createQueueRow(item, start + index)));
  ui.queueEmpty.hidden = pageItems.length > 0;
  ui.pagination.hidden = items.length <= PAGE_SIZE;
  ui.pageLabel.textContent = t("pageOf", { page: queuePage.toLocaleString(activeLanguage), pages: pages.toLocaleString(activeLanguage) });
  ui.previousPage.disabled = queuePage <= 1;
  ui.nextPage.disabled = queuePage >= pages;
  const processing = pageItems.find((item) => item.status === "processing");
  if (processing && processing.id !== lastProcessingItemId) {
    lastProcessingItemId = processing.id;
    window.requestAnimationFrame(() => {
      ui.queueList.querySelector(`[data-item-id="${CSS.escape(processing.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  } else if (!processing) {
    lastProcessingItemId = void 0;
  }
}
function renderLogs() {
  const entries = state.logs.slice(-100);
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level}`;
    const time = document.createElement("time");
    time.dateTime = new Date(entry.timestamp).toISOString();
    time.textContent = formatTime(entry.timestamp);
    const message = document.createElement("span");
    message.textContent = entry.message;
    row.append(time, message);
    fragment.append(row);
  }
  ui.activityLog.replaceChildren(fragment);
  ui.activityLog.hidden = entries.length === 0;
  ui.logEmpty.hidden = entries.length > 0;
  if (entries.length > 0) ui.activityLog.scrollTop = ui.activityLog.scrollHeight;
}
var lastQuotaNoticeShown = 0;
var lastCompletionShown = 0;
function maybeShowCompletionDialog() {
  const notice = state.completionNotice;
  if (!notice || !Number.isFinite(notice.at) || notice.at === lastCompletionShown) return;
  lastCompletionShown = notice.at;
  if (Date.now() - notice.at > 6e4) return;
  ui.completionDialogBody.textContent = t("completionDialogBody", {
    requested: Number(notice.requested ?? 0).toLocaleString(activeLanguage),
    skipped: Number(notice.skipped ?? 0).toLocaleString(activeLanguage),
    errors: Number(notice.errors ?? 0).toLocaleString(activeLanguage)
  });
  if (!ui.completionDialog.open && typeof ui.completionDialog.showModal === "function") ui.completionDialog.showModal();
}
function maybeShowQuotaDialog() {
  const notice = state.quotaNotice;
  if (!notice || !Number.isFinite(notice.at) || notice.at === lastQuotaNoticeShown) return;
  lastQuotaNoticeShown = notice.at;
  if (!ui.quotaDialog.open && typeof ui.quotaDialog.showModal === "function") ui.quotaDialog.showModal();
}
var renderCoalesceTimer = 0;
function scheduleRender() {
  if (renderCoalesceTimer) return;
  renderCoalesceTimer = window.setTimeout(() => {
    renderCoalesceTimer = 0;
    render();
  }, 400);
}
function render() {
  state.stats = computeStats(state.queue);
  maybeShowQuotaDialog();
  maybeShowCompletionDialog();
  renderHeader();
  renderConversion();
  renderDiscovery();
  renderSettings();
  renderControls();
  renderWaitProgress();
  renderStats();
  renderQueue();
  renderLogs();
  renderWizard();
}
async function applyResponse(response, successMessage) {
  if (!response.success) throw new Error(response.error ?? t("actionFailed"));
  if (response.state) state = response.state;
  render();
  if (successMessage) showToast(successMessage);
}
async function stopCurrentQueueForReplacement() {
  if (state.runState.status !== "running" && state.runState.status !== "stopping") return;
  if (!isExtensionContext) {
    state.runState = { status: "stopped", stopRequested: false, stoppedAt: Date.now() };
    return;
  }
  await applyResponse(await send({ type: "STOP_QUEUE" }));
  const deadline = Date.now() + 55e3;
  while (Date.now() < deadline) {
    const response = await send({ type: "GET_STATE" });
    if (!response.success) throw new Error(response.error ?? t("actionFailed"));
    if (response.state) state = response.state;
    if (state.runState.status !== "running" && state.runState.status !== "stopping") return;
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error(t("actionFailed"));
}
function parseDirectLinks(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((value) => String(value).trim()).filter((value) => /^https?:\/\//i.test(value)))];
      }
    } catch {
    }
  }
  return [...new Set(trimmed.split(/\r?\n|,|\s+(?=https?:\/\/)/).map((value) => value.trim().replace(/^[<([\]]+/, "").replace(/[>)\]]+$/, "").replace(/^(?:[-*•·]|[0-9]+[.)-])\s*/, "").replace(/["']/g, "").trim()).filter((value) => /^https?:\/\//i.test(value)))];
}
async function loadDirect() {
  if (busyAction === "load") return;
  const urls = parseDirectLinks(ui.directUrls.value);
  if (urls.length === 0) {
    showToast(t("noDirectUrlsFound"), "error");
    return;
  }
  setFormError();
  conversionError = "";
  conversionSource = "direct";
  conversionStatus = "loading";
  wizardDirection = "forward";
  wizardStep = 2;
  setBusy("load");
  render();
  try {
    await stopCurrentQueueForReplacement();
    await applyResponse(await send({ type: "LOAD_DIRECT_URLS", urls }), t("directUrlsAddedCount", { count: Number(state.discovery?.queuedCount ?? 0).toLocaleString(activeLanguage) }));
    conversionStatus = "success";
    if (ui.completionDialog.open) ui.completionDialog.close();
    ui.directUrls.value = "";
    ui.directFile.value = "";
    ui.directFileName.hidden = true;
    ui.directFileName.textContent = "";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    conversionStatus = "error";
    conversionError = message;
    showToast(message, "error");
  } finally {
    setBusy(null);
    render();
  }
}
async function handlePrimaryLoad(scope = "auto") {
  if (busyAction === "load") return;
  const sitemapUrl = ui.sitemapUrl.value.trim();
  const hasDirect = parseDirectLinks(ui.directUrls.value).length > 0;
  if (scope === "sitemap") {
    if (sitemapUrl) {
      await handleLoadSitemap();
      return;
    }
    if (hasDirect) {
      await loadDirect();
      return;
    }
    if (state.discovery && conversionStatus !== "error") {
      setWizardStep(2);
      return;
    }
    setFormError(t("invalidSitemap"));
    ui.sitemapUrl.focus();
    return;
  }
  let loadedAnything = false;
  if (sitemapUrl) {
    await handleLoadSitemap();
    loadedAnything = conversionStatus === "success";
  }
  if (parseDirectLinks(ui.directUrls.value).length > 0) {
    await loadDirect();
    loadedAnything = loadedAnything || conversionStatus === "success";
  }
  if (!loadedAnything && !sitemapUrl && !hasDirect) {
    if (state.discovery && conversionStatus !== "error") {
      setWizardStep(2);
      return;
    }
    setFormError(t("invalidSitemap"));
    ui.sitemapUrl.focus();
  }
}
async function handleLoadSitemap() {
  if (busyAction === "load") return;
  window.clearTimeout(sitemapAutoLoadTimer);
  const sitemapUrl = ui.sitemapUrl.value.trim();
  try {
    const parsed = new URL(sitemapUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
  } catch {
    setFormError(t("invalidSitemap"));
    ui.sitemapUrl.focus();
    return;
  }
  setFormError();
  conversionError = "";
  conversionSource = "sitemap";
  conversionStatus = "loading";
  wizardDirection = "forward";
  wizardStep = 2;
  setBusy("load");
  render();
  try {
    await stopCurrentQueueForReplacement();
    await applyResponse(await send({ type: "LOAD_SITEMAP", sitemapUrl }), `${t("sitemapLoaded")} · ${t("sitemapReadyCount", { count: Number(state.discovery?.queuedCount ?? 0).toLocaleString(activeLanguage) })}`);
    conversionStatus = "success";
    if (ui.completionDialog.open) ui.completionDialog.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    conversionStatus = "error";
    conversionError = message;
    showToast(message, "error");
  } finally {
    setBusy(null);
    render();
  }
}
async function saveSettings(settings) {
  try {
    await applyResponse(await send({ type: "UPDATE_SETTINGS", settings }));
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
    const response = await send({ type: "GET_STATE" });
    if (response.state) state = response.state;
    render();
    return false;
  }
}
async function runAction(action) {
  setBusy(action);
  try {
    const response = await send({ type: action === "start" ? "START_QUEUE" : "STOP_QUEUE" });
    await applyResponse(response, action === "start" ? t("queueStarted") : t("stopRequested"));
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(null);
  }
}
function logText() {
  return state.logs.map((entry) => `[${new Date(entry.timestamp).toLocaleString(activeLanguage)}] ${entry.level.toUpperCase()}: ${entry.message}`).join("\n");
}
function exportCsv() {
  const items = filteredQueue();
  if (items.length === 0) return;
  const escapeCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [["الرابط", "الحالة", "حالة Google", "النتيجة", "المحاولات", "تاريخ الإنشاء", "تاريخ الانتهاء"]];
  for (const item of items) {
    rows.push([
      item.url,
      statusLabel(item.status),
      gscStatusLabel(item.gscPageStatus),
      item.outcome ?? "",
      item.attemptCount ?? 0,
      item.createdAt ? new Date(item.createdAt).toISOString() : "",
      item.finishedAt ? new Date(item.finishedAt).toISOString() : ""
    ]);
  }
  const csv = "\uFEFF" + rows.map((row) => row.map(escapeCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `indexflow-queue-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 4e3);
  showToast(t("exportedCount", { count: items.length.toLocaleString(activeLanguage) }));
}
async function ingestFile(file) {
  ui.directFileName.hidden = false;
  ui.directFileName.textContent = file.name;
  ui.directFileName.title = file.name;
  try {
    ui.directUrls.value = await file.text();
  } catch {
    showToast(t("noDirectUrlsFound"), "error");
    return;
  }
  await loadDirect();
}
function bindEvents() {
  ui.loadDirectUrls.addEventListener("click", () => void loadDirect());
  ui.directUrls.addEventListener("input", () => renderWizard());
  ui.directFile.addEventListener("change", () => {
    const file = ui.directFile.files?.[0];
    if (file) void ingestFile(file);
  });
  const dropBox = ui.directUrls.closest(".direct-links-box");
  if (dropBox) {
    for (const dragType of ["dragenter", "dragover"]) {
      dropBox.addEventListener(dragType, (event) => {
        event.preventDefault();
        dropBox.classList.add("dragging");
      });
    }
    dropBox.addEventListener("dragleave", () => dropBox.classList.remove("dragging"));
    dropBox.addEventListener("drop", (event) => {
      event.preventDefault();
      dropBox.classList.remove("dragging");
      const file = event.dataTransfer?.files?.[0];
      if (file) void ingestFile(file);
    });
  }
  ui.sitemapForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void handlePrimaryLoad("sitemap");
  });
  for (const input of document.querySelectorAll('input[name="indexMode"]')) {
    input.addEventListener("click", () => {
      if (!input.checked) return;
      void saveSettings({ indexMode: input.value });
    });
  }
  const saveDelayInput = (input, setting) => {
    input.addEventListener("change", () => {
      const seconds = Number(input.value);
      if (!Number.isInteger(seconds) || !input.checkValidity()) {
        showToast(t("delayError"), "error");
        renderSettings();
        return;
      }
      void saveSettings({ [setting]: seconds });
    });
  };
  saveDelayInput(ui.indexDelaySeconds, "delaySeconds");
  ui.sitemapUrl.addEventListener("input", (event) => {
    window.clearTimeout(sitemapAutoLoadTimer);
    renderWizard();
    if (wizardStep !== 1 || busyAction !== null) return;
    const inputType = event.inputType ?? "";
    if (inputType !== "" && inputType !== "insertFromPaste" && inputType !== "insertFromDrop") return;
    try {
      const url = new URL(ui.sitemapUrl.value.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
    } catch {
      return;
    }
    sitemapAutoLoadTimer = window.setTimeout(() => void handleLoadSitemap(), 700);
  });
  ui.sitemapUrl.addEventListener("change", () => {
    if (wizardStep !== 1 || busyAction !== null) return;
    if (!ui.sitemapUrl.value.trim()) return;
    window.clearTimeout(sitemapAutoLoadTimer);
    void handleLoadSitemap();
  });
  ui.retryConversionButton.addEventListener("click", () => void handlePrimaryLoad("auto"));
  for (const button of ui.wizardProgress.querySelectorAll(".wizard-step")) {
    button.addEventListener("click", () => {
      const step = Number(button.dataset.step);
      if (step === 1 && wizardStep !== 1) void backToSourceStep();
      else setWizardStep(step);
    });
  }
  ui.wizardBackButton.addEventListener("click", goBackOneStep);
  ui.wizardNextButton.addEventListener("click", () => {
    if (wizardStep === 1) void handlePrimaryLoad("auto");
    else if (wizardStep === 2) setWizardStep(3);
    else if (wizardStep === 3) setWizardStep(4);
  });
  ui.startButton.addEventListener("click", () => void runAction("start"));
  ui.stopButton.addEventListener("click", () => void runAction("stop"));
  ui.resetButton.addEventListener("click", () => ui.resetDialog.showModal());
  ui.resetDialog.addEventListener("close", () => {
    if (ui.resetDialog.returnValue !== "confirm") return;
    void (async () => {
      setBusy("reset");
      try {
        await applyResponse(await send({ type: "RESET_ALL" }), t("allDataReset"));
        ui.queueSearch.value = "";
        ui.queueFilter.value = "all";
        ui.directUrls.value = "";
        ui.directFile.value = "";
        ui.directFileName.hidden = true;
        ui.directFileName.textContent = "";
        queuePage = 1;
        wizardStep = 1;
        wizardDirection = "back";
        lastRenderedWizardStep = 0;
        conversionStatus = "idle";
        conversionError = "";
        render();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), "error");
      } finally {
        setBusy(null);
      }
    })();
  });
  ui.queueSearch.addEventListener("input", () => {
    queuePage = 1;
    renderQueue();
  });
  for (const card of document.querySelectorAll(".stat-card[data-filter]")) {
    const applyFilter = () => {
      ui.queueFilter.value = card.dataset.filter;
      queuePage = 1;
      if (wizardStep !== 4) setWizardStep(4);
      renderQueue();
    };
    card.addEventListener("click", applyFilter);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        applyFilter();
      }
    });
  }
  ui.queueFilter.addEventListener("change", () => {
    queuePage = 1;
    renderQueue();
  });
  ui.previousPage.addEventListener("click", () => {
    queuePage = Math.max(1, queuePage - 1);
    renderQueue();
  });
  ui.nextPage.addEventListener("click", () => {
    queuePage += 1;
    renderQueue();
  });
  ui.copyLogsButton.addEventListener("click", () => {
    void navigator.clipboard.writeText(logText()).then(() => showToast(t("activityCopied")), () => showToast(t("copyFailed"), "error"));
  });
  ui.clearLogsButton.addEventListener("click", () => {
    void send({ type: "CLEAR_LOGS" }).then((response) => applyResponse(response, t("activityCleared")));
  });
  ui.exportCsvButton.addEventListener("click", exportCsv);
  ui.quotaDialogClose.addEventListener("click", () => ui.quotaDialog.close());
  ui.completionDialogClose.addEventListener("click", () => ui.completionDialog.close());
  ui.aboutButton.addEventListener("click", () => {
    if (!ui.aboutDialog.open && typeof ui.aboutDialog.showModal === "function") ui.aboutDialog.showModal();
  });
  ui.aboutClose.addEventListener("click", () => flyAvatarHome());
}
function ensureCairoFont() {
  try {
    if (!document.fonts || typeof document.fonts.load !== "function") return;
    void document.fonts.load('12px "Cairo"', "محمد Muhammed 0123").then(() => {
      try {
        if (document.fonts.check('12px "Cairo"')) return;
      } catch {
      }
      if (document.querySelector('link[data-cairo-fallback]')) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.cairoFallback = "1";
      link.href = "https://fonts.googleapis.com/css2?family=Cairo:wght@200..1000&display=swap";
      document.head.append(link);
    }).catch(() => {
      if (document.querySelector('link[data-cairo-fallback]')) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.dataset.cairoFallback = "1";
      link.href = "https://fonts.googleapis.com/css2?family=Cairo:wght@200..1000&display=swap";
      document.head.append(link);
    });
  } catch {
  }
}
async function initialize() {
  ensureCairoFont();
  bindEvents();
  window.setInterval(renderWaitProgress, 1e3);
  if (!isExtensionContext) {
    state = makePreviewState();
    const params = new URLSearchParams(location.search);
    const previewConversion = params.get("conversion");
    conversionStatus = previewConversion === "loading" ? "loading" : previewConversion === "error" ? "error" : "success";
    conversionError = conversionStatus === "error" ? "تعذر تحميل الروابط." : "";
    wizardStep = params.get("step") === "1" ? 1 : params.get("step") === "2" ? 2 : params.get("step") === "3" ? 3 : 4;
    await initLanguage();
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const changed = changes[STORAGE_KEY]?.newValue;
    if (!changed) return;
    state = changed;
    if (changed.discovery && conversionStatus === "idle") conversionStatus = "success";
    scheduleRender();
  });
  try {
    const response = await send({ type: "GET_STATE" });
    if (!response.success || !response.state) throw new Error(response.error ?? "تعذر تحميل حالة الإضافة.");
    state = response.state;
    conversionStatus = state.discovery ? "success" : "idle";
    wizardStep = state.runState.status === "running" || state.runState.status === "stopping" || state.runState.status === "completed" ? 4 : state.discovery ? 3 : 1;
    await initLanguage();
    try {
      const aboutFlag = await chrome.storage.local.get("ui.aboutShown");
      if (!aboutFlag["ui.aboutShown"]) {
        ui.aboutDialog.showModal();
        void chrome.storage.local.set({ "ui.aboutShown": true });
      }
    } catch {
    }
  } catch (error) {
    await initLanguage();
    showToast(error instanceof Error ? error.message : String(error), "error");
    render();
  }
}
void initialize();
