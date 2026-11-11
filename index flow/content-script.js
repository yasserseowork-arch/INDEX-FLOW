"use strict";
(() => {
  // src/types/state.ts
  var MIN_OPERATION_DELAY_SECONDS = 10;
  var DEFAULT_OPERATION_DELAY_SECONDS = 10;
  var SKIPPED_OPERATION_DELAY_SECONDS = 10;
  var DEFAULT_LIMIT_DELAY_SECONDS = 30 * 60;

  // src/utils/url.ts
  function getDomainKey(rawUrl) {
    try {
      return new URL(rawUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  function buildGscMainPageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.hostname !== "search.google.com") return null;
      const searchConsolePath = url.pathname.match(/^(\/(?:u\/[^/]+\/)?search-console)(?:\/|$)/)?.[1];
      const resourceId = url.searchParams.get("resource_id");
      if (!searchConsolePath || !resourceId) return null;
      const mainPage = new URL(searchConsolePath, url.origin);
      mainPage.searchParams.set("resource_id", resourceId);
      return mainPage.toString();
    } catch {
      return null;
    }
  }

  // src/services/queue-service.ts
  function shouldRequestForMode(mode, status) {
    if (mode === "both") return true;
    if (mode === "new_only") return status === "new_page";
    return status === "indexed_page";
  }

  // src/content/content-script.ts
  var INSPECTION_TIMEOUT_MS = 5e4;
  var INPUT_ACQUIRE_TIMEOUT_MS = 15e3;
  var DIALOG_TIMEOUT_MS = 3e5;
  var DIALOG_APPEAR_MS = 3e4;
  var OUTCOME_GRACE_MS = 12e3;
  var POLL_INTERVAL_MS = 500;
  var MAX_SUBMIT_RETRIES = 2;
  var SUBMIT_RETRY_DELAY_SECONDS = 15;
  var POST_SUCCESS_RESUME_KEY = "__gscBulkIndexerPostSuccessResume";
  var PAGE_GRACE_MS = 8e3;
  var PAGE_LOADED_AT = Date.now();
  var UNHEALTHY_POLL_EVERY = 8;
  var ERROR_PAGE_NEEDLES = [
    "something went wrong",
    "sorry, we",
    "that's an error",
    "server error",
    "temporarily unavailable",
    "unavailable right now",
    "try again in a few minutes",
    "can't reach this page",
    "حدث خطأ غير متوقع",
    "غير متاح مؤقتًا",
    "حاول مرة أخرى بعد قليل",
    "تعذر الوصول إلى هذه الصفحة"
  ];
  var PageReopenedError = class extends Error {
    constructor() {
      super("أُعيد فتح Search Console بسبب صفحة غير سليمة.");
      this.name = "PageReopenedError";
    }
  };
  var CanceledError = class extends Error {
    constructor() {
      super("تم إلغاء العملية.");
      this.name = "CanceledError";
    }
  };
  var activeRun = null;
  var heartbeatTimer = null;
  function sendHeartbeat(runId) {
    void sendMessage({ type: "HEARTBEAT", runId }).catch(() => void 0);
  }
  function startHeartbeat(runId) {
    stopHeartbeat();
    sendHeartbeat(runId);
    heartbeatTimer = window.setInterval(() => sendHeartbeat(runId), 2e4);
  }
  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
  function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CanceledError());
        return;
      }
      const timeout = window.setTimeout(() => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      }, milliseconds);
      const cancel = () => {
        window.clearTimeout(timeout);
        reject(new CanceledError());
      };
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  function waitTick(signal, fallbackMs = POLL_INTERVAL_MS) {
    return new Promise((resolve, reject) => {
      let done = false;
      let observer = null;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (observer) observer.disconnect();
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (observer) observer.disconnect();
        reject(new CanceledError());
      };
      const timer = window.setTimeout(finish, fallbackMs);
      try {
        observer = new MutationObserver(finish);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch {
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function assertNotCanceled(signal) {
    if (signal.aborted) throw new CanceledError();
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  async function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
  function log(level, message, runId) {
    void sendMessage({ type: "LOG", runId, level, message }).catch(() => void 0);
  }
  function readPostSuccessResume() {
    try {
      const rawValue = window.sessionStorage.getItem(POST_SUCCESS_RESUME_KEY);
      if (!rawValue) return null;
      const value = JSON.parse(rawValue);
      return typeof value.runId === "string" && typeof value.startedAt === "number" && typeof value.resumeAt === "number" ? { runId: value.runId, startedAt: value.startedAt, resumeAt: value.resumeAt } : null;
    } catch {
      return null;
    }
  }
  function writePostSuccessResume(runId, startedAt, resumeAt) {
    try {
      window.sessionStorage.setItem(POST_SUCCESS_RESUME_KEY, JSON.stringify({ runId, startedAt, resumeAt }));
      return true;
    } catch {
      return false;
    }
  }
  async function setWaitState(run, wait) {
    try {
      await sendMessage({ type: "SET_WAIT_STATE", runId: run.runId, wait });
    } catch {
    }
  }
  async function waitWithProgress(run, delaySeconds, reason) {
    const startedAt = Date.now();
    const until = startedAt + delaySeconds * 1e3;
    await setWaitState(run, { reason, startedAt, until });
    try {
      await sleep(delaySeconds * 1e3, run.controller.signal);
    } finally {
      await setWaitState(run);
    }
  }
  function clearPostSuccessResume(runId) {
    try {
      const saved = readPostSuccessResume();
      if (!runId || !saved || saved.runId === runId) window.sessionStorage.removeItem(POST_SUCCESS_RESUME_KEY);
    } catch {
    }
  }
  async function waitForPostSuccessResume(run) {
    const saved = readPostSuccessResume();
    if (!saved) return;
    if (saved.runId !== run.runId) {
      clearPostSuccessResume();
      return;
    }
    try {
      await setWaitState(run, { reason: "pacing", startedAt: saved.startedAt, until: saved.resumeAt });
      const remainingMilliseconds = saved.resumeAt - Date.now();
      if (remainingMilliseconds > 0) await sleep(remainingMilliseconds, run.controller.signal);
    } finally {
      clearPostSuccessResume(run.runId);
      await setWaitState(run);
    }
  }
  async function returnToMainPageAfterSuccess(run, delaySeconds, continueRunning) {
    const mainPageUrl = buildGscMainPageUrl(window.location.href);
    if (!mainPageUrl) return false;
    if (continueRunning) {
      const startedAt = Date.now();
      const resumeAt = startedAt + delaySeconds * 1e3;
      await setWaitState(run, { reason: "pacing", startedAt, until: resumeAt });
      if (!writePostSuccessResume(run.runId, startedAt, resumeAt)) {
        try {
          await sleep(delaySeconds * 1e3, run.controller.signal);
        } finally {
          await setWaitState(run);
        }
      }
    } else {
      clearPostSuccessResume(run.runId);
    }
    log("info", "جارٍ العودة إلى الصفحة الرئيسية لـ Search Console.", run.runId);
    window.location.replace(mainPageUrl);
    return true;
  }
  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  function normalizeText(text) {
    return (text ?? "").replace(/[\u0640\u064B-\u065F\u0670]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function includesAny(normalizedHaystack, needles) {
    for (const needle of needles) {
      if (normalizedHaystack.includes(normalizeText(needle))) return true;
    }
    return false;
  }
  function visibleText(root = document) {
    if (root instanceof HTMLElement && !isVisible(root)) return "";
    return normalizeText(root.textContent ?? "");
  }
  function visibleTextDeep(root = document.body) {
    if (!(root instanceof HTMLElement)) return "";
    if (!isVisible(root)) return "";
    let text = "";
    for (const child of root.childNodes) {
      if (child instanceof HTMLElement) text += " " + visibleTextDeep(child);
      else if (child.nodeType === Node.TEXT_NODE) text += " " + (child.textContent ?? "");
    }
    return normalizeText(text);
  }
  var NEW_PAGE_NEEDLES = [
    "url is not on google",
    "not on google",
    "url is not available to google",
    "url is not available on google",
    "not available to google",
    "not available on google",
    "page is not indexed",
    "url is unknown to google",
    "الرابط ليس على google",
    "الرابط غير موجود على google",
    "لم تتم فهرسة عنوان url",
    "لم تتم فهرسة الصفحة",
    "غير متاح على google",
    "غير متوفر على google",
    "عنوان url غير متوفر على محرك بحث google",
    "عنوان url غير متاح على محرك بحث google",
    "عنوان url غير متوفر",
    "عنوان url غير متاح"
  ];
  var INDEXED_PAGE_NEEDLES = [
    "url is on google",
    "url is available to google",
    "url is available on google",
    "available to google",
    "available on google",
    "page is indexed",
    "الرابط متاح على google",
    "الرابط موجود على google",
    "تمت فهرسة عنوان url",
    "تمت فهرسة الصفحة",
    "متاح على google",
    "متوفر على google",
    "عنوان url متوفر على محرك بحث google",
    "عنوان url متاح على محرك بحث google",
    "عنوان url متوفر",
    "عنوان url متاح"
  ];
  function pageStatusFromText(text) {
    if (includesAny(text, NEW_PAGE_NEEDLES)) return "new_page";
    if (includesAny(text, INDEXED_PAGE_NEEDLES)) return "indexed_page";
    return "unknown";
  }
  function pageShowsUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      let bare = (url.hostname + url.pathname).toLowerCase();
      if (bare.endsWith("/")) bare = bare.slice(0, -1);
      if (!bare) return false;
      const text = visibleTextDeep(document.body);
      if (!text) return false;
      let decodedBare = bare;
      try {
        decodedBare = (url.hostname + decodeURIComponent(url.pathname)).toLowerCase();
        if (decodedBare.endsWith("/")) decodedBare = decodedBare.slice(0, -1);
      } catch {
      }
      for (const candidate of [bare, decodedBare]) {
        if (text.includes(candidate)) return true;
        const withoutWww = candidate.replace(/^www\./, "");
        if (withoutWww !== candidate && text.includes(withoutWww)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  var INSPECTION_INPUT_SELECTORS = [
    'input[jsname="dSO9oc"]',
    'input[aria-label*="inspect any url" i]',
    'input[placeholder*="inspect any url" i]',
    'input[aria-label*="افحص"]',
    'input[placeholder*="افحص"]',
    'input[aria-label*="عنوان url" i]',
    'input[placeholder*="عنوان url" i]',
    'input[aria-label*="url" i]',
    'input[placeholder*="url" i]'
  ];
  function findInspectionInput(requireVisible = true) {
    for (const selector of INSPECTION_INPUT_SELECTORS) {
      for (const input of Array.from(document.querySelectorAll(selector))) {
        if (!(input instanceof HTMLInputElement) || input.disabled || input.type === "hidden") continue;
        if (!requireVisible || isVisible(input)) return input;
      }
    }
    return null;
  }
  function revealElement(element) {
    let node = element;
    let steps = 0;
    while (node && node !== document.body && steps < 15) {
      const style = window.getComputedStyle(node);
      if (style.display === "none") node.style.setProperty("display", node === element ? "inline-block" : "block", "important");
      else if (style.visibility === "hidden") node.style.setProperty("visibility", "visible", "important");
      else if (isVisible(node)) break;
      node = node.parentElement;
      steps += 1;
    }
    if (element instanceof HTMLInputElement && !isVisible(element)) {
      element.style.setProperty("width", "320px", "important");
      element.style.setProperty("height", "32px", "important");
    }
  }
  function findSearchToggle() {
    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const candidate of candidates) {
      if (!isVisible(candidate)) continue;
      if (candidate.closest('a, nav, [role="navigation"], [role="dialog"]')) continue;
      const label = normalizeText((candidate.getAttribute("aria-label") ?? "") + " " + (candidate.getAttribute("title") ?? ""));
      if (!label) continue;
      if (["search", "open search", "show search", "search bar", "بحث", "افتح البحث", "ابحث", "اظهر البحث", "افحص", "فحص"].includes(label)) return candidate;
      if (label.includes("open search") || label.includes("inspect any url") || label.includes("افحص أي عنوان") || label.includes("فتح البحث")) return candidate;
    }
    return null;
  }
  async function acquireInspectionInput(signal, runId) {
    const deadline = Date.now() + INPUT_ACQUIRE_TIMEOUT_MS;
    const startedAt = Date.now();
    let toggleAttempts = 0;
    let lastToggleAt = -Infinity;
    let loggedStruggle = false;
    let healthChecked = false;
    while (Date.now() < deadline) {
      assertNotCanceled(signal);
      if (!healthChecked && Date.now() - startedAt > 6e3) {
        healthChecked = true;
        const health = pageHealth();
        if (!health.healthy && health.reason !== "login") {
          const reopened = await requestReopen(health.reason, runId);
          if (reopened) throw new PageReopenedError();
        }
      }
      const input = findInspectionInput();
      if (input) {
        if (loggedStruggle) log("info", "تم إظهار حقل فحص الروابط.", runId);
        return input;
      }
      if (!loggedStruggle) {
        loggedStruggle = true;
        log("info", "حقل فحص الروابط غير ظاهر — جارٍ محاولة إظهاره تلقائيًا (كبّر نافذة المتصفح إن استمرت المشكلة).", runId);
      }
      const hiddenInput = findInspectionInput(false);
      if (hiddenInput) {
        revealElement(hiddenInput);
        const revealed = findInspectionInput();
        if (revealed) {
          log("info", "تم إظهار حقل فحص الروابط.", runId);
          return revealed;
        }
      }
      if (toggleAttempts < 4 && Date.now() - lastToggleAt > 2500) {
        const toggle = findSearchToggle();
        if (toggle) {
          toggle.click();
          toggleAttempts += 1;
          lastToggleAt = Date.now();
        }
      }
      await waitTick(signal, 600);
    }
    return null;
  }
  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function findRequestButton() {
    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const candidate of candidates) {
      if (!isVisible(candidate)) continue;
      const text = visibleText(candidate);
      if (!includesAny(text, ["request indexing", "request again", "طلب فهرسة", "طلب الفهرسة"])) continue;
      const disabled = candidate.getAttribute("aria-disabled") === "true" || candidate.hasAttribute("disabled") || candidate instanceof HTMLButtonElement && candidate.disabled;
      if (!disabled) return candidate;
    }
    return null;
  }
  function timeoutFactor() {
    return document.hidden ? 1.75 : 1;
  }
  async function waitForInspection(signal, itemUrl, preSubmitStatus) {
    const deadline = Date.now() + INSPECTION_TIMEOUT_MS * timeoutFactor();
    const softDeadline = Date.now() + 25e3 * timeoutFactor();
    let latestStatus = "unknown";
    let latestButton = null;
    let stablePolls = 0;
    let lastEvalAt = 0;
    let polls = 0;
    await sleep(1200, signal);
    while (Date.now() < deadline) {
      assertNotCanceled(signal);
      const tickNow = Date.now();
      if (tickNow - lastEvalAt < 350) {
        await waitTick(signal, 350);
        continue;
      }
      lastEvalAt = tickNow;
      polls += 1;
      await maybeReopenIfUnhealthy(polls, void 0);
      latestStatus = pageStatusFromText(visibleTextDeep(document.body));
      latestButton = findRequestButton();
      if (latestStatus !== "unknown") {
        const urlShown = itemUrl ? pageShowsUrl(itemUrl) : true;
        const transitioned = latestStatus !== preSubmitStatus;
        if (urlShown || transitioned) {
          stablePolls += 1;
          if (stablePolls >= 2) return { pageStatus: latestStatus, requestButton: latestButton };
        } else if (Date.now() > softDeadline) {
          return { pageStatus: latestStatus, requestButton: latestButton };
        }
      } else {
        stablePolls = 0;
      }
      await waitTick(signal);
    }
    return { pageStatus: latestStatus, requestButton: latestButton };
  }
  function modeSkipReason(mode, status, url) {
    if (mode === "new_only" && status === "indexed_page") return `تم تخطي رابط مفهرس مسبقًا في وضع "الجديد فقط": ${url}`;
    if (mode === "reindex_only" && status === "new_page") return `تم تخطي رابطًا جديدًا في وضع "إعادة الفهرسة فقط": ${url}`;
    return `تم التخطي حسب وضع الفهرسة: ${url}`;
  }
  function isRealDialog(element) {
    const ariaModal = (element.getAttribute("aria-modal") || "").toLowerCase();
    if (ariaModal === "true") return true;
    if (ariaModal === "false") return false;
    const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("wiz-aria-label") || ""} ${element.className || ""}`.toLowerCase();
    if (label.includes("drawer") || label.includes("navigation") || label.includes("تنقل") || label.includes("التنقل")) return false;
    return element.getAttribute("role") === "dialog";
  }
  function visibleDialogs() {
    return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter((element) => isVisible(element) && isRealDialog(element));
  }
  function isSubmitProblemText(text) {
    return includesAny(text, [
      "problem submitting your indexing request",
      "we had a problem submitting",
      "oops",
      "something went wrong",
      "try again later",
      "عذرا",
      "حدث خطأ",
      "واجهنا مشكلة",
      "مشكلة في إرسال",
      "مشكلة في ارسال",
      "حاول مرة أخرى لاحقًا",
      "إعادة المحاولة لاحقًا"
    ]);
  }
  function dismissDialog(dialog) {
    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"], a')).filter(isVisible);
    const dismiss = buttons.find((button) => {
      const text = visibleText(button);
      if (text === "ok" || text === "close" || text === "done" || text === "حسنا" || text === "موافق" || text === "تم" || text === "اغلاق" || text === "تمام" || text === "dismiss" || text === "تجاهل" || text === "اغلق") return true;
      return text.includes("got it") || text.includes("فهمت");
    });
    dismiss?.click();
  }
  function isTestingText(text) {
    return includesAny(text, [
      "testing if live url can be indexed",
      "this might take a minute or two",
      "جارٍ اختبار",
      "يجري اختبار",
      "اختبار ما إذا كان يمكن فهرسة",
      "اختبار إمكانية فهرسة",
      "قد يستغرق هذا دقيقة أو دقيقتين",
      "دقيقة أو دقيقتين"
    ]);
  }
  var BODY_QUOTA_NEEDLES = [
    "تجاوزت الحد المسموح به يومياً",
    "الحد المسموح به يومياً",
    "تجاوزت حصتك اليومية",
    "استنفدت حصتك اليومية",
    "استنفدت حصة الفهرسة اليومية",
    "quota exceeded",
    "exceeded your daily quota",
    "try submitting this again tomorrow"
  ];
  async function waitForDialog(url, pageStatus, runId) {
    const hardDeadline = Date.now() + DIALOG_TIMEOUT_MS * timeoutFactor();
    const appearDeadline = Date.now() + DIALOG_APPEAR_MS * timeoutFactor();
    const startedAt = Date.now();
    let sawActivity = false;
    let testingSeen = false;
    let testingLastSeenAt = 0;
    let lastProgressLogAt = 0;
    let lastEvalAt = 0;
    let polls = 0;
    while (Date.now() < hardDeadline) {
      const tickNow = Date.now();
      if (tickNow - lastEvalAt < 350) {
        await waitTick(void 0, 350);
        continue;
      }
      lastEvalAt = tickNow;
      polls += 1;
      await maybeReopenIfUnhealthy(polls, runId);
      for (const dialog of visibleDialogs()) {
        const text = visibleText(dialog);
        if (!text) continue;
        sawActivity = true;
        if (includesAny(text, [
          "quota exceeded",
          "daily quota",
          "exceeded your quota",
          "exceeded your daily quota",
          "quota limit",
          "try submitting this again tomorrow",
          "تم تجاوز الحصة",
          "تجاوزت الحصة",
          "تجاوزت حصتك",
          "استنفدت الحصة",
          "استنفدت حصتك",
          "الحد اليومي",
          "حصتك اليومية",
          "حصة الفهرسة اليومية",
          "المحاولة غدًا",
          "مرة أخرى غدًا",
          "إعادة إرسال هذا غدًا",
          "تجاوزت الحد المسموح به",
          "الحد المسموح به يومياً"
        ])) {
          dismissDialog(dialog);
          return {
            outcome: "quota",
            gscPageStatus: pageStatus,
            reason: `تم بلوغ حد الفهرسة اليومي لنطاق ${getDomainKey(url) || "هذا النطاق"}.`,
            domain: getDomainKey(url)
          };
        }
        if (includesAny(text, [
          "indexing requested",
          "request submitted",
          "successfully submitted",
          "submitted for indexing",
          "تم طلب الفهرسة",
          "تم إرسال الطلب",
          "تم الإرسال بنجاح",
          "تم إرسال عنوان url",
          "أُرسل عنوان url"
        ])) {
          dismissDialog(dialog);
          return {
            outcome: "accepted",
            gscPageStatus: pageStatus,
            reason: `تم قبول طلب الفهرسة: ${url}`
          };
        }
        if (includesAny(text, ["indexing request rejected", "request rejected", "تم رفض طلب الفهرسة", "تم رفض الطلب"])) {
          dismissDialog(dialog);
          return {
            outcome: "error",
            gscPageStatus: pageStatus,
            reason: `رفض Search Console طلب الفهرسة: ${url}`
          };
        }
        if (isSubmitProblemText(text)) {
          dismissDialog(dialog);
          return {
            outcome: "submit_problem",
            gscPageStatus: pageStatus,
            reason: `أبلغ Search Console عن خطأ أثناء إرسال الطلب: ${url}`
          };
        }
      }
      const bodyText = visibleTextDeep(document.body);
      if (includesAny(bodyText, BODY_QUOTA_NEEDLES)) {
        return {
          outcome: "quota",
          gscPageStatus: pageStatus,
          reason: `تم بلوغ حد الفهرسة اليومي لنطاق ${getDomainKey(url) || "هذا النطاق"}.`,
          domain: getDomainKey(url)
        };
      }
      if (isTestingText(bodyText)) {
        sawActivity = true;
        if (!testingSeen) {
          testingSeen = true;
          lastProgressLogAt = Date.now();
          log("info", "جارٍ انتظار نتيجة الاختبار الحي من Search Console — قد يستغرق دقيقة أو دقيقتين أو أكثر.", runId);
        } else if (Date.now() - lastProgressLogAt > 30e3) {
          lastProgressLogAt = Date.now();
          log("info", `لا يزال الاختبار الحي جاريًا (${Math.round((Date.now() - startedAt) / 1e3)} ثانية من الانتظار حتى الآن).`, runId);
        }
        testingLastSeenAt = Date.now();
        await waitTick(void 0, 1e3);
        continue;
      }
      if (!sawActivity && Date.now() > appearDeadline) {
        return {
          outcome: "error",
          gscPageStatus: pageStatus,
          reason: `لم يظهر مربع تأكيد طلب الفهرسة: ${url}`
        };
      }
      if (testingSeen && Date.now() - testingLastSeenAt > OUTCOME_GRACE_MS) {
        return {
          outcome: "error",
          gscPageStatus: pageStatus,
          reason: `انتهى اختبار الفهرسة دون ظهور تأكيد واضح من Search Console: ${url}`
        };
      }
      await waitTick(void 0, 750);
    }
    return {
      outcome: "error",
      gscPageStatus: pageStatus,
      reason: `انتهت المهلة قبل تأكيد Search Console لطلب الفهرسة: ${url}`
    };
  }
  function currentResourceIdRaw() {
    try {
      return new URL(window.location.href).searchParams.get("resource_id") || "";
    } catch {
      return "";
    }
  }
  function currentPropertyHost() {
    const resourceId = currentResourceIdRaw();
    if (resourceId.startsWith("sc-domain:")) return resourceId.slice("sc-domain:".length).toLowerCase();
    if (resourceId.startsWith("sc-")) {
      try {
        return new URL(resourceId.slice(3)).hostname.toLowerCase();
      } catch {
        return "";
      }
    }
    if (/:\/\//.test(resourceId)) {
      try {
        return new URL(resourceId).hostname.toLowerCase();
      } catch {
        return "";
      }
    }
    return "";
  }
  function hostMatchesProperty(itemUrl) {
    const propertyHost = currentPropertyHost();
    if (!propertyHost) return true;
    const itemHost = getDomainKey(itemUrl);
    if (!itemHost) return false;
    const stripWww = (host) => host.replace(/^www\./, "");
    return stripWww(itemHost) === stripWww(propertyHost) || itemHost.endsWith("." + stripWww(propertyHost));
  }

  // src/content/property-switch.ts
  var ACCESS_ERROR_NEEDLES = ["access to this property", "verify your ownership", "حق الوصول", "الوصول إلى هذه الخاصية", "التحقق من ملكيتك"];
  var UNVERIFIED_HEADER_RE = /^(not verified|unverified|غير مثبتة|غير مثبّتة|لم يتم التحقق|بدون تحقق)/i;
  var ADD_PROPERTY_RE = /add property|add a property|إضافة خاصية|إضافة property/i;
  var PROPERTY_TOKEN_RE = /(https?:\/\/[^\s]+|sc-domain:[^\s]+)/i;
  function pageShowsAccessError() {
    return includesAny(visibleTextDeep(document.body), ACCESS_ERROR_NEEDLES);
  }
  function propertyTokenHost(token) {
    if (!token) return "";
    if (token.toLowerCase().startsWith("sc-domain:")) return token.slice("sc-domain:".length).toLowerCase();
    try {
      return new URL(token).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  function propertyMatchScore(token, targetHost) {
    const host = propertyTokenHost(token);
    if (!host || !targetHost) return -1;
    const strip = (value) => value.replace(/^www\./, "");
    const bareTarget = strip(targetHost);
    const bareHost = strip(host);
    const isDomain = token.toLowerCase().startsWith("sc-domain:");
    if (host === targetHost) return isDomain ? 5 : 4;
    if (isDomain) {
      if (bareHost === bareTarget) return 3;
      if (targetHost.endsWith("." + bareHost)) return 3;
      return -1;
    }
    if (bareHost === bareTarget) return 2;
    return -1;
  }
  function findPropertyTrigger() {
    const selectors = [
      "#resource-selector-container [jsname='MOZAcf']",
      "#resource-selector-container [role='button'][aria-haspopup='menu']",
      "[jsname='MOZAcf']",
      "#resource-selector-container input[role='combobox']:not([disabled])",
      "#resource-selector-container [role='button']"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }
  function propertyListbox() {
    return document.querySelector("[jsname='iuXDpb']") || document.querySelector("#resource-selector-container [role='listbox']") || document.querySelector("[role='listbox']");
  }
  function propertyPickerOpen() {
    const listbox = propertyListbox();
    if (listbox) {
      if (listbox.getAttribute("data-expanded") === "true") return true;
      if (Number(listbox.getAttribute("data-childcount") || 0) > 0) return true;
      if (listbox.childElementCount > 0) return true;
    }
    return document.querySelectorAll("[role='option']").length > 0;
  }
  function pressElement(element) {
    for (const type of ["mousedown", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }
  async function openPropertyPicker(signal) {
    if (propertyPickerOpen()) return true;
    const trigger = findPropertyTrigger();
    if (!trigger) return false;
    pressElement(trigger);
    if (!propertyPickerOpen()) {
      const input = document.querySelector("#resource-selector-container input[role='combobox']:not([disabled])");
      if (input) {
        try {
          input.focus();
        } catch {
        }
        pressElement(input);
        if (!propertyPickerOpen()) {
          for (const type of ["keydown", "keyup"]) {
            input.dispatchEvent(new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
          }
        }
      }
    }
    const deadline = Date.now() + 6e3;
    while (Date.now() < deadline) {
      if (propertyPickerOpen()) return true;
      await waitTick(signal, 250);
    }
    return propertyPickerOpen();
  }
  function clickableAncestor(node) {
    let current = node;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (current.getAttribute && (current.getAttribute("role") === "option" || current.tagName === "A" || current.tagName === "BUTTON")) return current;
      current = current.parentElement;
    }
    current = node;
    for (let depth = 0; current && depth < 6; depth += 1) {
      try {
        if (window.getComputedStyle(current).cursor === "pointer") return current;
      } catch {
      }
      current = current.parentElement;
    }
    return node;
  }
  function scanPropertyOptions(targetHost) {
    const nodes = Array.from(document.querySelectorAll("[role='option'], [jsname='iuXDpb'] *, [role='listbox'] *"));
    const unverifiedHeader = nodes.find((node) => {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      return text.length > 0 && text.length <= 40 && UNVERIFIED_HEADER_RE.test(text);
    });
    const seen = new Map();
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 120 || ADD_PROPERTY_RE.test(text)) continue;
      const tokenMatch = text.match(PROPERTY_TOKEN_RE);
      if (!tokenMatch) continue;
      const token = tokenMatch[1].replace(/[),.;]+$/, "");
      if (!propertyTokenHost(token)) continue;
      if (unverifiedHeader && node !== unverifiedHeader && (unverifiedHeader.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      let navigateUrl = "";
      if (typeof node.querySelector === "function") {
        const anchor = node.querySelector("a[href]");
        if (anchor) {
          try {
            const abs = new URL(anchor.getAttribute("href") || "", window.location.href);
            if (abs.hostname === "search.google.com" && abs.searchParams.get("resource_id")) navigateUrl = abs.toString();
          } catch {
          }
        }
      }
      const score = propertyMatchScore(token, targetHost);
      const previous = seen.get(token);
      if (!previous || node.children.length < previous.node.children.length) {
        seen.set(token, { token, score, node, navigateUrl });
      } else if (navigateUrl && !previous.navigateUrl) {
        previous.navigateUrl = navigateUrl;
      }
    }
    const available = [...seen.values()].map((entry) => entry.token);
    const currentRaw = currentResourceIdRaw();
    const matching = [...seen.values()]
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || (a.token === currentRaw ? 1 : 0) - (b.token === currentRaw ? 1 : 0));
    const best = matching[0];
    return {
      best: best ? { token: best.token, clickable: clickableAncestor(best.node), navigateUrl: best.navigateUrl || "" } : null,
      available
    };
  }
  function pageHealth() {
    try {
      const host = window.location.hostname;
      if (host === "accounts.google.com") return { healthy: false, reason: "login" };
      if (!host.endsWith("search.google.com")) return { healthy: false, reason: "off_gsc" };
      const shell = document.querySelector("#resource-selector-container");
      if (shell) return { healthy: true, reason: "" };
      const text = visibleTextDeep(document.body);
      if (!shell) {
        const stillLoading = document.readyState !== "complete" || Date.now() - PAGE_LOADED_AT < PAGE_GRACE_MS;
        if (stillLoading && text.length < 60) return { healthy: true, reason: "" };
        if (text.length < 60) return { healthy: false, reason: "blank" };
        if (includesAny(text, ERROR_PAGE_NEEDLES)) return { healthy: false, reason: "error_page" };
        return { healthy: false, reason: "no_shell" };
      }
      return { healthy: true, reason: "" };
    } catch {
      return { healthy: true, reason: "" };
    }
  }
  async function requestReopen(reason, runId) {
    log("warning", `رُصدت صفحة غير سليمة في تبويب كونسول (${reason}) — جارٍ طلب إعادة الفتح والاستئناف التلقائي.`, runId);
    try {
      const response = await sendMessage({ type: "GSC_REOPEN_REQUEST", reason, runId });
      return Boolean(response?.reopened);
    } catch {
      return false;
    }
  }
  async function maybeReopenIfUnhealthy(polls, runId) {
    if (polls % UNHEALTHY_POLL_EVERY !== 0) return;
    const health = pageHealth();
    if (health.healthy || health.reason === "login") return;
    const reopened = await requestReopen(health.reason, runId);
    if (reopened) throw new PageReopenedError();
  }
  async function processUrl(item, mode, signal, runId, inspectionAlreadyOpen = false) {
    let pageStatus = "unknown";
    try {
      assertNotCanceled(signal);
      if (!inspectionAlreadyOpen && !hostMatchesProperty(item.url)) {
        return {
          outcome: "skipped_mode",
          gscPageStatus: "unknown",
          reason: `الرابط خارج نطاق موقع Search Console المفتوح — تم تخطيه: ${item.url}`
        };
      }
      for (const leftover of visibleDialogs()) dismissDialog(leftover);
      if (!inspectionAlreadyOpen && pageShowsAccessError()) {
        return {
          outcome: "error",
          gscPageStatus: "unknown",
          reason: `تبويب Search Console مفتوح على Property بدون صلاحية وصول لحسابك الحالي — افتح قائمة Properties أعلى يسار الصفحة واختار موقعك الصحيح، ثم أعد المحاولة: ${item.url}`
        };
      }
      const preSubmitStatus = pageStatusFromText(visibleTextDeep(document.body));
      if (!inspectionAlreadyOpen) {
        const input = await acquireInspectionInput(signal, runId);
        if (!input) {
          const health = pageHealth();
          if (!health.healthy && health.reason !== "login") {
            const reopened = await requestReopen(health.reason, runId);
            if (reopened) throw new PageReopenedError();
          }
          return {
            outcome: "error",
            gscPageStatus: "unknown",
            reason: "لم يتم العثور على حقل فحص الروابط في Search Console. كبّر نافذة المتصفح أو اضغط أيقونة البحث في الشريط العلوي لإظهار الحقل، ثم أعد المحاولة."
          };
        }
        log("info", `جارٍ فحص ${item.url}`, runId);
        try {
          if (typeof input.scrollIntoView === "function") input.scrollIntoView({ block: "center" });
        } catch {
        }
        input.focus();
        setInputValue(input, item.url);
        await sleep(250, signal);
        if (input.value !== item.url) setInputValue(input, item.url);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
      } else {
        log("info", `استئناف الفحص لـ ${item.url}`, runId);
      }
      const inspection = await waitForInspection(signal, item.url, preSubmitStatus);
      pageStatus = inspection.pageStatus;
      if (pageStatus === "unknown" && mode !== "both") {
        return {
          outcome: "error",
          gscPageStatus: pageStatus,
          reason: `تعذر تحديد ما إذا كان الرابط مفهرسًا في جوجل؛ لم يُرسل أي طلب: ${item.url}`
        };
      }
      if (!shouldRequestForMode(mode, pageStatus)) {
        return {
          outcome: "skipped_mode",
          gscPageStatus: pageStatus,
          reason: modeSkipReason(mode, pageStatus, item.url)
        };
      }
      const requestButton = inspection.requestButton ?? findRequestButton();
      if (!requestButton) {
        return {
          outcome: "error",
          gscPageStatus: pageStatus,
          reason: `إجراء "طلب الفهرسة" غير متاح لهذا الرابط: ${item.url}`
        };
      }
      assertNotCanceled(signal);
      requestButton.click();
      log("info", `تم إرسال طلب الفهرسة لـ ${item.url}؛ في انتظار تأكيد Search Console.`, runId);
      let result = await waitForDialog(item.url, pageStatus, runId);
      let submitRetries = 0;
      while (result.outcome === "submit_problem" && submitRetries < MAX_SUBMIT_RETRIES) {
        submitRetries += 1;
        log("warning", `ظهرت رسالة خطأ أثناء إرسال الطلب لـ ${item.url} — تم إغلاقها، وإعادة المحاولة ${submitRetries}/${MAX_SUBMIT_RETRIES} بعد ${SUBMIT_RETRY_DELAY_SECONDS} ثانية.`, runId);
        await sleep(SUBMIT_RETRY_DELAY_SECONDS * 1e3, signal);
        assertNotCanceled(signal);
        const retryButton = findRequestButton();
        if (!retryButton) {
          return {
            outcome: "error",
            gscPageStatus: pageStatus,
            reason: `زر طلب الفهرسة غير متاح بعد رسالة الخطأ: ${item.url}`
          };
        }
        retryButton.click();
        log("info", `إعادة إرسال طلب الفهرسة لنفس الرابط (${submitRetries}/${MAX_SUBMIT_RETRIES}): ${item.url}`, runId);
        result = await waitForDialog(item.url, pageStatus, runId);
      }
      if (result.outcome === "submit_problem") {
        return {
          outcome: "error",
          gscPageStatus: pageStatus,
          reason: `أبلغ Search Console عن خطأ أثناء إرسال الطلب بعد ${MAX_SUBMIT_RETRIES + 1} محاولات: ${item.url}`
        };
      }
      return result;
    } catch (error) {
      if (error instanceof PageReopenedError) {
        return { outcome: "canceled", gscPageStatus: pageStatus, reason: `${error.message} الرابط رجع للطابور وهيتعالج تلقائيًا بعد الاستئناف: ${item.url}` };
      }
      if (error instanceof CanceledError || signal.aborted) {
        return { outcome: "canceled", gscPageStatus: pageStatus, reason: `تم الإيقاف قبل الإرسال: ${item.url}` };
      }
      return { outcome: "error", gscPageStatus: pageStatus, reason: `خطأ أتمتة في ${item.url}: ${errorMessage(error)}` };
    }
  }
  async function runQueue(run, resumeWork) {
    try {
      await waitForPostSuccessResume(run);
      run.loopAlive = true;
      while (!run.controller.signal.aborted && activeRun?.runId === run.runId) {
        run.loopAlive = true;
        const health = pageHealth();
        if (!health.healthy && health.reason === "login") {
          log("error", "انتهت صلاحية تسجيل الدخول إلى جوجل في تبويب كونسول — سجّل الدخول ثم ابدأ الطابور مجددًا.", run.runId);
          break;
        }
        if (!health.healthy) {
          const reopened = await requestReopen(health.reason, run.runId);
          if (reopened) break;
        }
        const resumed = resumeWork;
        resumeWork = void 0;
        let work;
        if (resumed) {
          work = { success: true, item: resumed.item, operationId: resumed.operationId, indexMode: resumed.indexMode };
        } else {
          const response = await sendMessage({ type: "NEXT_ITEM", runId: run.runId });
          work = response.work;
          if (!response.success || !work?.success) throw new Error(response.error ?? work?.error ?? "تعذر جلب الرابط التالي.");
        }
        if (work.done || !work.item || !work.operationId || !work.indexMode) break;
        const result = await processUrl(work.item, work.indexMode, run.controller.signal, run.runId, Boolean(resumed));
        const reported = await sendMessage({
          type: "REPORT_RESULT",
          runId: run.runId,
          operationId: work.operationId,
          itemId: work.item.id,
          result
        });
        const resultResponse = reported.result;
        if (!reported.success || !resultResponse?.success) break;
        const delaySeconds = result.outcome === "skipped_mode" ? Math.max(SKIPPED_OPERATION_DELAY_SECONDS, resultResponse.delaySeconds) : Math.max(MIN_OPERATION_DELAY_SECONDS, resultResponse.delaySeconds);
        if (result.outcome === "accepted") {
          if (resultResponse.continueRunning) {
            log("info", `انتظار ${delaySeconds} ثانية في الصفحة الرئيسية قبل الرابط التالي.`, run.runId);
          }
          if (await returnToMainPageAfterSuccess(run, delaySeconds, resultResponse.continueRunning)) break;
        }
        if (!resultResponse.continueRunning) break;
        log(
          result.outcome === "quota" ? "warning" : "info",
          result.outcome === "quota" ? `تم بلوغ حد الحصة. انتظار ${delaySeconds} ثانية قبل إعادة المحاولة.` : `انتظار ${delaySeconds} ثانية قبل الرابط التالي.`,
          run.runId
        );
        const waitReason = result.outcome === "quota" ? "quota" : result.outcome === "skipped_mode" ? "skipped" : "pacing";
        await waitWithProgress(run, delaySeconds, waitReason);
      }
    } catch (error) {
      if (!(error instanceof CanceledError) && !run.controller.signal.aborted) {
        log("error", `توقف مشغّل الطابور: ${errorMessage(error)}`, run.runId);
      }
    } finally {
      run.loopAlive = false;
      if (activeRun?.runId === run.runId) {
        activeRun = null;
        stopHeartbeat();
      }
    }
  }
  function startRun(runId, resumeWork) {
    if (activeRun?.runId === runId && activeRun.loopAlive) return;
    activeRun?.controller.abort();
    activeRun = { runId, controller: new AbortController() };
    startHeartbeat(runId);
    void runQueue(activeRun, resumeWork);
  }
  function stopRun(runId) {
    if (!activeRun) return;
    if (runId && activeRun.runId !== runId) return;
    activeRun.controller.abort();
  }
  function gscToolText(element) {
    return normalizeText(element?.innerText || element?.textContent || "");
  }
  function gscToolVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  }
  function validationState(text) {
    const value = normalizeText(text);
    if (/\bnot\s*started\b|\bnot-started\b|لم\s*يبدأ|لم\s*تبدأ|لم\s*يتم\s*البدء/.test(value)) return { key: "not_started", label: "Not Started" };
    if (/\bstarted\b|\bin\s*progress\b|جار[ٍي]?\s*التحقق|بدأ\s*التحقق|قيد\s*التحقق/.test(value)) return { key: "started", label: "Started" };
    if (/\bpassed\b|\bvalid\b|اجتاز|تم\s*التحقق|صالح/.test(value)) return { key: "passed", label: "Passed" };
    if (/\bfailed\b|فشل\s*التحقق|لم\s*يجتز/.test(value)) return { key: "failed", label: "Failed" };
    return null;
  }
  function findVisibleAction(patterns, root = document) {
    const candidates = root.querySelectorAll("button, [role=button], [role=menuitem], a");
    return Array.from(candidates).find((element) => gscToolVisible(element) && patterns.some((pattern) => pattern.test(gscToolText(element) || element.getAttribute("aria-label") || element.getAttribute("title") || ""))) || null;
  }
  function getGscReportAvailability() {
    const navItems = Array.from(document.querySelectorAll('nav a, nav button, [role="navigation"] a, [role="navigation"] button, [role="navigation"] [role="link"]'))
      .filter(gscToolVisible)
      .map((element) => gscToolText(element));
    const coreWebVitalsVisible = navItems.some((text) => /core web vitals|مؤشرات الويب الأساسية/.test(text));
    return { coreWebVitalsVisible, inspectedNavigation: navItems.length > 0 };
  }
  function readGscReport() {
    const body = document.body?.innerText || "";
    const normalizedBody = normalizeText(body);
    const candidates = new Set([
      ...document.querySelectorAll('[role="row"]'),
      ...document.querySelectorAll("table tr")
    ]);
    const rows = [];
    for (const element of candidates) {
      if (!gscToolVisible(element)) continue;
      const text = (element.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 3 || text.length > 1200) continue;
      const status = validationState(text);
      if (!status && !/not indexed|excluded|indexing|صفحات|مفهرس|مستبعد|robots\.txt|noindex|blocked|forbidden|403|404|canonical|alternate page|redirect|soft 404|server error|discovered|crawled|core web vitals|cls|lcp|inp|غير موجود|محظور|ممنوع|تحويل|صفحة بديلة|روبوت|خطأ.*الخادم/i.test(text)) continue;
      const lines = (element.innerText || "").split(/\n+/).map((part) => part.trim()).filter(Boolean);
      const reason = lines.find((line) => !validationState(line) && !/^website$|^google$|^not applicable$|^n\/a$/i.test(line)) || text;
      const countMatch = text.match(/(?:^|\s)(\d[\d,.\s]*\d|\d+)(?:\s|$)/);
      rows.push({ reason: reason.slice(0, 240), text: text.slice(0, 500), validation: status?.key || "unknown", validationLabel: status?.label || "", count: countMatch?.[1]?.trim() || "" });
      if (rows.length >= 120) break;
    }
    const cwvNoData = /not enough data|no data available|insufficient data|بيانات غير كافية|لا توجد بيانات كافية|لا تتوفر بيانات/.test(normalizedBody);
    const title = document.querySelector('h1, [role="heading"][aria-level="1"]')?.innerText?.trim() || document.title || "Google Search Console";
    let notStartedCount = rows.filter((row) => row.validation === "not_started").length;
    if (!notStartedCount && validationState(body)?.key === "not_started") notStartedCount = 1;
    const startAction = findVisibleAction([/^(start validation|start fixing|validate fix|ابدأ التحقق|بدء التحقق|التحقق من الإصلاح)$/i]);
    const pageIsCwv = /core-web-vitals/i.test(location.pathname);
    const availability = pageIsCwv && cwvNoData ? "التقرير الاختياري لا يحتوي بيانات كافية حاليًا." : "";
    return { title: title.slice(0, 200), url: location.href, rows, rowCount: rows.length, notStartedCount, canStartValidation: Boolean(startAction && notStartedCount > 0), availability, cwvNoData };
  }
  function readGscSitemaps() {
    const candidates = new Set([...document.querySelectorAll('[role="row"]'), ...document.querySelectorAll("table tr")]);
    const rows = [];
    for (const element of candidates) {
      if (!gscToolVisible(element)) continue;
      const raw = element.innerText || "";
      const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!lines.length || /^(sitemap|type|submitted|last read|status|discovered pages)$/i.test(lines[0])) continue;
      const link = Array.from(element.querySelectorAll("a[href]"))
        .find((candidate) => /sitemap/i.test(`${candidate.href} ${candidate.innerText || ""}`));
      const urlMatch = raw.match(/https?:\/\/[\s\S]*?\.xml(?:\.gz)?|\/[^\s]*sitemap[\s\S]*?\.xml(?:\.gz)?/i);
      const url = link?.href || (urlMatch?.[0] || "").replace(/\s+/g, "");
      if (!url) continue;
      const statusLine = lines.find((line) => /success|couldn.t fetch|fetch error|pending|processing|failed|successfully|نجاح|تعذر|قيد المعالجة|فشل/i.test(line)) || "";
      const countMatches = [...raw.matchAll(/(?:^|\s)(\d[\d,.]*)(?=\s|$)/g)].map((match) => match[1]);
      const total = countMatches.length ? countMatches[countMatches.length - 1] : "";
      rows.push({ sitemap: url.slice(0, 600), status: statusLine.slice(0, 100) || "", count: total, text: raw.replace(/\s+/g, " ").trim().slice(0, 500) });
      if (rows.length >= 100) break;
    }
    return { title: document.querySelector('h1, [role="heading"][aria-level="1"]')?.innerText?.trim() || "Sitemaps", url: location.href, rows, rowCount: rows.length };
  }
  async function startVisibleValidation() {
    const report = readGscReport();
    if (!report.notStartedCount) return { started: false, message: "لم أجد حالة Not Started ظاهرة في الصفحة الحالية. افتح تفاصيل المشكلة ثم أعد المحاولة." };
    const action = findVisibleAction([/^(start validation|start fixing|validate fix|ابدأ التحقق|بدء التحقق|التحقق من الإصلاح)$/i]);
    if (!action) return { started: false, message: "حالة Not Started موجودة، لكن زر بدء التحقق غير ظاهر في هذه الصفحة. افتح تفاصيل المشكلة في Search Console؛ قد يلزم إصلاح الموقع أولًا." };
    action.click();
    return { started: true, message: "تم الضغط على بدء التحقق في Search Console. راجع الصفحة للتأكد من قبول الطلب." };
  }
  async function submitVisibleSitemap(sitemapUrl, propertyId) {
    let target;
    try { target = new URL(String(sitemapUrl || "")); } catch { return { status: "unavailable", available: false, message: "رابط Sitemap غير صالح." }; }
    const inputs = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio])"))
      .filter((input) => gscToolVisible(input) && !input.disabled);
    const input = inputs.find((candidate) => /sitemap|site map|خريطة الموقع/i.test(`${candidate.placeholder || ""} ${candidate.getAttribute("aria-label") || ""} ${candidate.name || ""} ${candidate.parentElement?.innerText || ""}`));
    if (!input) return { status: "unavailable", available: false, message: "لم أجد حقل إضافة Sitemap. تأكد أن تبويب Sitemaps فتح على الـ Property الصحيح." };
    const propertyHost = String(propertyId || "").replace(/^sc-domain:/, "").replace(/^sc-/, "").replace(/^https?:\/\//, "").split(/[/?#]/)[0].toLowerCase();
    const prefixText = `${input.parentElement?.innerText || ""} ${input.parentElement?.parentElement?.innerText || ""}`;
    const visiblePrefix = prefixText.match(/https?:\/\/[^\s/]+/i)?.[0];
    let value = target.toString();
    if (visiblePrefix) {
      let prefixHost = "";
      try { prefixHost = new URL(visiblePrefix).hostname.toLowerCase(); } catch {}
      if (prefixHost && target.hostname.toLowerCase() !== prefixHost && target.hostname.toLowerCase() !== propertyHost && !propertyHost.endsWith(`.${target.hostname.toLowerCase()}`)) {
        return { status: "unavailable", available: false, message: `الخريطة ${target.hostname} لا تطابق الـ Property الحالي (${propertyHost || prefixHost}).` };
      }
      if (target.hostname.toLowerCase() === prefixHost) value = `${target.pathname.replace(/^\//, "")}${target.search}`;
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter) valueSetter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 180));
    const submitButton = findVisibleAction([/^(submit|add|إرسال|إضافة|إرسال خريطة الموقع)$/i]);
    if (!submitButton || submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true") {
      return { status: "unavailable", available: false, message: "املأ الحقل يدويًا في صفحة Sitemaps؛ زر الإرسال غير متاح أو تغيرت واجهة Google." };
    }
    submitButton.click();
    return { status: "submitted", available: true, message: "تم إرسال Sitemap إلى Search Console. انتظر حتى تظهر نتيجة Google في جدول الخرائط." };
  }
  async function requestRobotsRecrawl() {
    const robotCandidates = Array.from(document.querySelectorAll('[role="row"], table tr, section, article, div'))
      .filter((element) => gscToolVisible(element) && /robots\.txt/i.test(element.innerText || ""));
    if (!robotCandidates.length) return { available: false, message: "تقرير robots.txt غير ظاهر لهذا الـ Property. قد لا تتوفر هذه الخانة لكل المواقع." };
    const openPatterns = [/^(open report|عرض التقرير|فتح التقرير)$/i];
    let row = robotCandidates.find((element) => element.matches('[role="row"], tr') && findVisibleAction(openPatterns, element))
      || robotCandidates.find((element) => findVisibleAction(openPatterns, element))
      || robotCandidates.filter((element) => (element.innerText || "").length < 700).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
    if (!row) return { available: false, message: "لم أجد بطاقة robots.txt أو زر فتح التقرير." };
    const openReport = findVisibleAction(openPatterns, row);
    if (openReport) {
      openReport.click();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const refreshed = Array.from(document.querySelectorAll('[role="row"], table tr, section, article, div'))
        .filter((element) => gscToolVisible(element) && /robots\.txt/i.test(element.innerText || ""));
      row = refreshed.find((element) => element.matches('[role="row"], tr') && element.querySelector('button, [role="button"]'))
        || refreshed.filter((element) => (element.innerText || "").length < 900).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0]
        || row;
    }
    let menuButton = Array.from(row.querySelectorAll('button, [role="button"]')).find((element) => gscToolVisible(element) && /more|menu|options|المزيد|قائمة|المزيد من الخيارات/i.test(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${gscToolText(element)}`));
    if (!menuButton) menuButton = Array.from(row.querySelectorAll('button, [role="button"]')).filter(gscToolVisible).at(-1);
    if (!menuButton) return { available: false, message: "لم أجد قائمة الإجراءات الخاصة بملف robots.txt في هذه الصفحة." };
    menuButton.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const recrawl = findVisibleAction([/^(request a recrawl|request recrawl|recrawl|طلب إعادة الزحف|إعادة الزحف)$/i]);
    if (!recrawl) return { available: false, message: "لم يظهر خيار Request a recrawl. قد لا يكون متاحًا لهذا الموقع أو تغيرت واجهة Google." };
    recrawl.click();
    return { available: true, requested: true, message: "تم اختيار طلب إعادة زحف robots.txt. اتبع أي تأكيد إضافي يظهر في Search Console." };
  }

  function installListener() {
    const marker = "__gscBulkIndexerContentLoaded";
    const markedWindow = window;
    if (markedWindow[marker]) return;
    markedWindow[marker] = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      switch (message.type) {
        case "GSC_GET_REPORT_AVAILABILITY":
          sendResponse({ success: true, data: getGscReportAvailability() });
          return false;
        case "GSC_READ_REPORT":
          sendResponse({ success: true, data: readGscReport() });
          return false;
        case "GSC_READ_SITEMAPS":
          sendResponse({ success: true, data: readGscSitemaps() });
          return false;
        case "GSC_START_VALIDATION":
          void startVisibleValidation().then((data) => sendResponse({ success: true, data })).catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        case "GSC_SUBMIT_SITEMAP":
          void submitVisibleSitemap(message.sitemapUrl, message.propertyId).then((data) => sendResponse({ success: true, data })).catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        case "GSC_REQUEST_ROBOTS_RECRAWL":
          void requestRobotsRecrawl().then((data) => sendResponse({ success: true, data })).catch((error) => sendResponse({ success: false, error: errorMessage(error) }));
          return true;
        case "PING":
          sendResponse({ success: true, activeRunId: activeRun?.runId, loopAlive: Boolean(activeRun?.loopAlive) });
          return false;
        case "KICK_RUN":
          if (activeRun?.runId === message.runId && activeRun.loopAlive) {
            startHeartbeat(message.runId);
            sendResponse({ success: true, already: true });
          } else {
            startRun(message.runId);
            sendResponse({ success: true, already: false });
          }
          return false;
        case "START_RUN":
          startRun(message.runId);
          sendResponse({ success: true });
          return false;
        case "RESUME_RUN":
          startRun(message.runId, { item: message.item, operationId: message.operationId, indexMode: message.indexMode });
          sendResponse({ success: true });
          return false;
        case "STOP_RUN":
          stopRun(message.runId);
          sendResponse({ success: true });
          return false;
        case "PROPERTY_STATUS": {
          const host = String(message.host || "").toLowerCase();
          const current = currentPropertyHost();
          const strip = (value) => value.replace(/^www\./, "");
          const match = !current || strip(current) === strip(host) || current.endsWith("." + strip(host));
          sendResponse({ success: true, match, accessError: pageShowsAccessError(), currentHost: current, currentRaw: currentResourceIdRaw() });
          return false;
        }
        case "SWITCH_PROPERTY": {
          const host = String(message.host || "").toLowerCase();
          void (async () => {
            try {
              const current = currentPropertyHost();
              const strip = (value) => value.replace(/^www\./, "");
              const alreadyOk = current && (strip(current) === strip(host) || current.endsWith("." + strip(host))) && !pageShowsAccessError();
              if (alreadyOk) {
                sendResponse({ success: true, already: true, resourceId: currentResourceIdRaw() });
                return;
              }
              const opened = await openPropertyPicker();
              if (!opened) {
                sendResponse({ success: false, error: "لم أتمكن من فتح قائمة Properties في الصفحة الحالية.", available: [] });
                return;
              }
              const scan = scanPropertyOptions(host);
              if (!scan.best) {
                sendResponse({ success: false, error: `لا يوجد Property مطابق للموقع ${host} داخل القائمة المتاحة.`, available: scan.available });
                return;
              }
              sendResponse({ success: true, resourceId: scan.best.token, navigateUrl: scan.best.navigateUrl || "" });
              if (!scan.best.navigateUrl) {
                setTimeout(() => {
                  try {
                    pressElement(scan.best.clickable);
                  } catch {
                  }
                }, 80);
              }
            } catch (error) {
              sendResponse({ success: false, error: errorMessage(error), available: [] });
            }
          })();
          return true;
        }
      }
    });
  }
  installListener();
})();
