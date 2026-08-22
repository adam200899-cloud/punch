/**
 * 打卡平台 — 單檔完整版(由 src/ 合併產生)
 */


// ╔═══ Config.gs ═══

/**
 * Config.gs — 平台層設定
 *
 * 架構:一套 Apps Script 服務多家公司(多租戶)
 *   主控表  → 公司清單、管理員、邀請碼、系統紀錄
 *   各公司  → 自己的一份試算表(員工 / 打卡紀錄 / 允許網段 / 設定 / 月報)
 *
 * 需要手動設定的指令碼屬性(其餘由系統自動產生):
 *   MASTER_SPREADSHEET_ID  主控表的試算表 ID
 *   SETUP_CODE             首次啟用碼,用來把第一個平台管理員登記進系統
 *   WEBHOOK_TOKEN          LINE Webhook 網址上的共享密鑰
 *
 * 各公司的 LINE 憑證存在指令碼屬性 LINE_{公司代碼},由後台寫入,
 * 不放在試算表裡,避免分享試算表時外流。
 */

const PROP = PropertiesService.getScriptProperties();

const CONFIG = {
  get masterId()     { return PROP.getProperty('MASTER_SPREADSHEET_ID') || ''; },
  get setupCode()    { return PROP.getProperty('SETUP_CODE') || ''; },
  get webhookToken() { return PROP.getProperty('WEBHOOK_TOKEN') || ''; },
  get trustProxy()   { return PROP.getProperty('TRUST_PROXY') === 'true'; },
  get proxySecret()  { return PROP.getProperty('PROXY_SECRET') || ''; },

  /** 後台 session 簽章密鑰,第一次使用時自動產生 */
  get sessionSecret() {
    let s = PROP.getProperty('SESSION_SECRET');
    if (!s) {
      s = Utilities.getUuid() + Utilities.getUuid();
      PROP.setProperty('SESSION_SECRET', s);
    }
    return s;
  },

  TZ: 'Asia/Taipei',
  SESSION_HOURS: 12,
};

// ─────────────────────────── 主控表結構 ───────────────────────────

const M = {
  COMPANY: '公司',
  ADMIN:   '管理員',
  INVITE:  '邀請碼',
  LOG:     '系統紀錄',
};

const M_HEADERS = {
  [M.COMPANY]: ['公司代碼', '公司名稱', '平台', '試算表ID', '狀態', '建立時間', '備註'],
  [M.ADMIN]:   ['LINE_UserID', '姓名', '角色', '公司代碼', '狀態', '建立時間'],
  [M.INVITE]:  ['邀請碼', '角色', '公司代碼', '到期時間', '已使用', '使用者', '建立時間'],
  [M.LOG]:     ['時間', '層級', '來源', '訊息'],
};

// ─────────────────────────── 公司試算表結構 ───────────────────────────

const SHEETS = {
  EMPLOYEE:  '員工',
  RECORD:    '打卡紀錄',
  ALLOWIP:   '允許網段',
  SETTING:   '設定',
  REPORT:    '月報',
  LEAVE:     '請假申請',
  LEAVETYPE: '假別',
  RULES:     '工作守則',
};

const HEADERS = {
  [SHEETS.EMPLOYEE]: ['員工編號', '姓名', '部門', '平台UserID', '暱稱', '狀態', '綁定時間', '備註'],
  [SHEETS.RECORD]:   ['時間戳記', '日期', '時間', '員工編號', '姓名', '部門', '類型', '判定', '地點', '來源IP', 'IP驗證', '裝置', '備註'],
  [SHEETS.ALLOWIP]:  ['規則', '地點名稱', '啟用', '說明'],
  [SHEETS.SETTING]:  ['項目', '值', '說明'],
  [SHEETS.LEAVE]:    ['申請編號', '申請時間', '員工編號', '姓名', '部門', '假別',
                      '開始日期', '開始時段', '結束日期', '結束時段', '天數', '事由',
                      '狀態', '審核人', '審核時間', '審核備註'],
  [SHEETS.LEAVETYPE]:['假別', '需提前天數', '年度上限', '給薪比例', '需附證明', '啟用', '法源與說明'],
  [SHEETS.RULES]:    ['排序', '標題', '內容', '啟用'],
};

const DEFAULT_SETTINGS = [
  ['上班時間',     '09:00', '判定遲到的基準時間,格式 HH:mm'],
  ['下班時間',     '18:00', '判定早退的基準時間,格式 HH:mm'],
  ['遲到寬限分鐘', 10,      '超過上班時間幾分鐘才算遲到'],
  ['早退寬限分鐘', 10,      '早於下班時間幾分鐘內不算早退'],
  ['重複打卡間隔', 3,       '同一種類型幾分鐘內重複送出會被擋下'],
  ['啟用IP驗證',   'TRUE',  'FALSE 可暫時關閉地點限制(測試用)'],
  ['預設提前天數', 3,       '沒有特別指定的假別,要提前幾天申請'],
  ['請假需審核',   'TRUE',  'FALSE 則員工送出後直接生效,不需管理員同意'],
];

/**
 * 預設假別 —— 依《勞動基準法》與《勞工請假規則》設定。
 * 「需提前天數」設 0 的是法律上不能要求預先申請的假別
 * (生病、奔喪、職災不可能提前三天知道,雇主不得以未預先申請為由拒絕)。
 * 詳細法源見 docs/台灣勞工制度.md。
 */
const DEFAULT_LEAVE_TYPES = [
  ['特別休假',       3, '依年資',  '100%', '否', 'TRUE', '勞基法§38。年資6個月3日、1年7日、2年10日、3年14日、5年15日、10年起每年+1日至30日'],
  ['事假',           3, 14,        '0%',   '否', 'TRUE', '勞工請假規則§7。全年合計不得超過14日,不給工資'],
  ['普通傷病假',     0, 30,        '50%',  '連續3日以上需診斷證明', 'TRUE', '勞工請假規則§4。未住院1年內合計不超過30日,工資折半發給'],
  ['生理假',         0, 3,         '50%',  '否', 'TRUE', '性別平等工作法§14。每月1日,全年逾3日之部分併入病假計算'],
  ['家庭照顧假',     3, 7,         '0%',   '否', 'TRUE', '性別平等工作法§20。全年7日,併入事假計算'],
  ['婚假',           3, 8,         '100%', '否', 'TRUE', '勞工請假規則§2。8日,應於結婚前10日起3個月內請畢'],
  ['喪假',           0, '3/6/8',   '100%', '否', 'TRUE', '勞工請假規則§3。父母配偶8日、祖父母子女6日、曾祖父母兄弟姊妹3日'],
  ['公傷病假',       0, '依醫囑',  '100%', '需職災認定', 'TRUE', '勞工請假規則§6、勞基法§59。職業災害醫療期間,雇主應補償原領工資'],
  ['產假',           3, 56,        '依年資', '需證明', 'TRUE', '勞基法§50。分娩前後停止工作8週,受僱6個月以上工資照給'],
  ['陪產檢及陪產假', 3, 7,         '100%', '否', 'TRUE', '性別平等工作法§15。7日,配偶分娩前後15日期間內擇日'],
  ['公假',           0, '依需要',  '100%', '需公文', 'TRUE', '勞工請假規則§8。依法令規定應給公假者'],
];

/** 預設工作守則 —— 依法規產生的基本版,建立公司後可在後台自行增修 */
const DEFAULT_RULES = [
  [1, '出勤與打卡', '請於上班時間前抵達並完成上班打卡,下班離開前完成下班打卡。\n打卡須連線公司 Wi-Fi,使用行動網路無法打卡。\n忘記打卡請當日告知主管補登,出勤紀錄依法須保存5年。', 'TRUE'],
  [2, '工作時間',   '正常工時每日不超過8小時、每週不超過40小時(勞基法§30)。\n連續工作4小時應至少休息30分鐘(§35)。\n每7日應有2日休息,1日為例假、1日為休息日(§36)。', 'TRUE'],
  [3, '加班規定',   '加班須事先取得主管同意。\n延長工時連同正常工時每日不得超過12小時,每月延長工時不得超過46小時;經工會或勞資會議同意得延長至54小時,每3個月不得超過138小時(§32)。\n加班費:平日前2小時1⅓倍、第3小時起1⅔倍;休息日前2小時1⅓倍、第3小時起1⅔倍(§24)。', 'TRUE'],
  [4, '請假規定',   '事假、特休、婚假等可預期的假別,請於開始日3個工作天前提出申請並取得核准。\n病假、喪假、公傷病假等突發狀況,請於當日儘速通知主管並事後補件。\n各假別的天數上限與給薪比例,請見請假頁面的說明。', 'TRUE'],
  [5, '請假流程',   '1. 在聊天室點「🗓 請假」開啟申請表\n2. 選擇假別、起訖日期與時段,填寫事由\n3. 送出後由主管審核\n4. 核准或駁回會用訊息通知你', 'TRUE'],
];

// ─────────────────────────── 常數 ───────────────────────────

const PUNCH_IN  = '上班';
const PUNCH_OUT = '下班';

const LEAVE_STATUS = { PENDING: '待審核', APPROVED: '已核准', REJECTED: '已駁回', CANCELLED: '已取消' };

/**
 * 員工狀態。
 * 待設定 = 員工已經綁定 Telegram,但管理員還沒填他是誰,還不能打卡。
 */
const EMP_STATUS = { PENDING: '待設定', ACTIVE: '在職', LEFT: '離職' };

const ROLE = { PLATFORM: '平台', COMPANY: '公司' };

const ERR = {
  NOT_BOUND:   'NOT_BOUND',
  INACTIVE:    'INACTIVE',
  IP_DENIED:   'IP_DENIED',
  DUPLICATE:   'DUPLICATE',
  BAD_TOKEN:   'BAD_TOKEN',
  NO_COMPANY:  'NO_COMPANY',
  NOT_PROXIED: 'NOT_PROXIED',
  UNAUTHORIZED:'UNAUTHORIZED',
  FORBIDDEN:   'FORBIDDEN',
  SERVER:      'SERVER',
};

// ─────────────────────────── 後台登入用的平台 bot ───────────────────────────

/**
 * 管理員登入也是走聊天平台的身分驗證。平台管理員自己挑一個平台:
 *   telegram → 用平台 bot 的 token 驗證 WebApp initData
 *   line     → 用平台 LINE Login channel 驗證 idToken
 * @return {{platform:string, loginChannelId:string, botToken:string}}
 */
function getAdminAuth_() {
  const platform = PROP.getProperty('ADMIN_PLATFORM') || '';
  const botToken = PROP.getProperty('ADMIN_BOT_TOKEN') || '';
  const loginChannelId = PROP.getProperty('ADMIN_LOGIN_CHANNEL_ID') || '';

  if (platform) return { platform: platform, botToken: botToken, loginChannelId: loginChannelId };

  // 沒特別指定就沿用第一家設定完成的公司,省掉重複設定
  const co = listCompanies_().find(c => botReady_(getBot_(c.code)));
  if (!co) return { platform: '', botToken: '', loginChannelId: '' };
  const b = getBot_(co.code);
  return { platform: b.platform, botToken: b.botToken, loginChannelId: b.loginChannelId };
}

/** 驗證後台登入者的身分 */
function verifyAdminIdentity_(auth) {
  const a = getAdminAuth_();
  if (!a.platform) return { ok: false, error: '平台尚未設定任何 bot,請先建立第一家公司' };
  if (a.platform === 'telegram') return tgVerifyInitData_(a.botToken, (auth || {}).initData);
  return lineVerifyIdToken_((auth || {}).idToken, a.loginChannelId);
}


// ╔═══ Bot.gs ═══

/**
 * Bot.gs — 通訊平台抽象層
 *
 * 每家公司可以選 LINE 或 Telegram。上層(打卡、指令、後台)一律透過
 * 這裡的函式操作,不必知道底下是哪一個平台。
 *
 * 憑證存在指令碼屬性 BOT_{公司代碼},不寫進試算表。
 */

const PLATFORM = { LINE: 'line', TELEGRAM: 'telegram' };

const PLATFORM_LABEL = { line: 'LINE', telegram: 'Telegram' };

function botKey_(companyCode) {
  return 'BOT_' + String(companyCode).trim().toUpperCase();
}

/**
 * @return {{platform:string, channelAccessToken:string, loginChannelId:string,
 *           loginChannelSecret:string, liffId:string, botToken:string, botUsername:string}}
 */
function getBot_(companyCode) {
  const raw = PROP.getProperty(botKey_(companyCode));
  const o = raw ? JSON.parse(raw) : {};
  return {
    platform:           o.platform || PLATFORM.LINE,
    channelAccessToken: o.channelAccessToken || '',
    loginChannelId:     o.loginChannelId || '',
    loginChannelSecret: o.loginChannelSecret || '',
    liffId:             o.liffId || '',
    botToken:           o.botToken || '',
    botUsername:        o.botUsername || '',
  };
}

/** 儲存;秘密欄位留空代表「維持原值」,後台才不用每次重貼 */
function setBot_(companyCode, patch) {
  const cur = getBot_(companyCode);
  const keep = (v, old) => (v === '' || v == null ? old : String(v).trim());
  const next = {
    platform:           patch.platform || cur.platform,
    channelAccessToken: keep(patch.channelAccessToken, cur.channelAccessToken),
    loginChannelId:     patch.loginChannelId     == null ? cur.loginChannelId     : String(patch.loginChannelId).trim(),
    loginChannelSecret: keep(patch.loginChannelSecret, cur.loginChannelSecret),
    liffId:             patch.liffId             == null ? cur.liffId             : String(patch.liffId).trim(),
    botToken:           keep(patch.botToken, cur.botToken),
    botUsername:        patch.botUsername        == null ? cur.botUsername        : String(patch.botUsername).trim(),
  };
  PROP.setProperty(botKey_(companyCode), JSON.stringify(next));
  return next;
}

function deleteBot_(companyCode) {
  PROP.deleteProperty(botKey_(companyCode));
}

/** 這家公司的設定是否已經可以運作 */
function botReady_(bot) {
  return bot.platform === PLATFORM.TELEGRAM
    ? !!bot.botToken
    : !!(bot.channelAccessToken && bot.loginChannelId && bot.liffId);
}

// ─────────────────────────── 身分驗證 ───────────────────────────

/**
 * 驗證前端送來的身分憑證。兩個平台的憑證都是由平台簽章的,前端無法偽造。
 * @param {string} companyCode
 * @param {{idToken?:string, initData?:string}} auth
 * @return {{ok:boolean, userId?:string, displayName?:string, error?:string}}
 */
function botVerifyUser_(companyCode, auth) {
  const bot = getBot_(companyCode);
  if (bot.platform === PLATFORM.TELEGRAM) {
    return tgVerifyInitData_(bot.botToken, (auth || {}).initData);
  }
  return lineVerifyIdToken_((auth || {}).idToken, bot.loginChannelId);
}

// ─────────────────────────── 發送訊息 ───────────────────────────

function botPushText_(companyCode, userId, text) {
  const bot = getBot_(companyCode);
  if (bot.platform === PLATFORM.TELEGRAM) return tgSend_(bot.botToken, userId, text);
  return linePush_(companyCode, userId, textMsg_(text));
}

/** 打卡成功的確認訊息 */
function botPushPunchResult_(companyCode, userId, r) {
  const bot = getBot_(companyCode);
  if (bot.platform === PLATFORM.TELEGRAM) {
    return tgSend_(bot.botToken, userId,
      `<b>✅ ${r.type}打卡成功</b>\n` +
      `<code>${r.time}</code>  ${r.dateText}\n\n` +
      `姓名:${r.name}(${r.code})\n` +
      `地點:${r.location}\n` +
      `判定:${r.judgement}`);
  }
  return linePush_(companyCode, userId, punchFlex_(r));
}

// ─────────────────────────── 打卡頁網址 ───────────────────────────

function pageBaseUrl_() {
  return (PROP.getProperty('PAGE_BASE_URL') || '').replace(/\/+$/, '');
}

/** 員工實際點開的打卡連結 */
function punchEntryUrl_(companyCode) {
  const bot = getBot_(companyCode);
  if (bot.platform === PLATFORM.TELEGRAM) {
    const base = pageBaseUrl_();
    return base ? `${base}/index.html?c=${companyCode}` : '';
  }
  return bot.liffId ? 'https://liff.line.me/' + bot.liffId : '';
}

/** LIFF 的 Endpoint URL / Telegram WebApp 的 URL(兩者其實是同一個頁面) */
function punchPageUrl_(companyCode) {
  const base = pageBaseUrl_();
  return base ? `${base}/index.html?c=${companyCode}` : '';
}

/** 請假申請頁(Telegram WebApp / LIFF 共用同一份) */
function leavePageUrl_(companyCode) {
  const base = pageBaseUrl_();
  return base ? `${base}/leave.html?c=${companyCode}` : '';
}

function webhookUrl_(companyCode) {
  const exec = webAppUrl_();
  if (!exec) return '';
  const bot = getBot_(companyCode);
  const p = bot.platform === PLATFORM.TELEGRAM ? 'tg' : 'webhook';
  return `${exec}?p=${p}&c=${companyCode}&token=${CONFIG.webhookToken}`;
}

// ─────────────────────────── 自動設定 ───────────────────────────

/**
 * 盡可能把平台端的設定自動做完。
 * Telegram:設定 webhook、選單按鈕、指令清單 —— 全自動。
 * LINE:如果有給 Login channel secret,自動建立 LIFF;webhook 仍需手動貼。
 * @return {{done:string[], manual:string[]}}
 */
function botAutoSetup_(companyCode, companyName) {
  const bot = getBot_(companyCode);
  const done = [], manual = [];
  const pageUrl = punchPageUrl_(companyCode);
  const hook = webhookUrl_(companyCode);

  if (!pageUrl) manual.push('請先到「平台管理 → 平台設定」填入打卡頁網址,否則員工開不了打卡頁。');
  if (!hook)    manual.push('取不到 Web App 網址,請確認已部署為網頁應用程式。');

  if (bot.platform === PLATFORM.TELEGRAM) {
    if (hook) {
      const r = tgSetWebhook_(bot.botToken, hook);
      r.ok ? done.push('已自動設定 Telegram Webhook') : manual.push('Webhook 設定失敗:' + r.message);
    }
    if (pageUrl) {
      const r = tgSetMenuButton_(bot.botToken, pageUrl);
      r.ok ? done.push('已自動設定聊天室的「打卡」按鈕') : manual.push('選單按鈕設定失敗:' + r.message);
    }
    const c = tgSetCommands_(bot.botToken);
    if (c.ok) done.push('已自動設定指令清單');

  } else {
    if (!bot.liffId && bot.loginChannelId && bot.loginChannelSecret && pageUrl) {
      const r = lineCreateLiff_(bot.loginChannelId, bot.loginChannelSecret, pageUrl, companyName);
      if (r.ok) {
        setBot_(companyCode, { liffId: r.liffId });
        done.push('已自動建立 LIFF(ID:' + r.liffId + ')');
      } else {
        manual.push('自動建立 LIFF 失敗:' + r.message + ' — 請到 LINE Developers 手動建立後把 LIFF ID 填回來。');
      }
    } else if (!bot.liffId) {
      manual.push('尚未設定 LIFF ID。填入 Login channel secret 可讓系統自動建立,或手動建好後填入 LIFF ID。');
    }
    if (hook) manual.push('請把 Webhook URL 貼到 Messaging API channel 並開啟 Use webhook(LINE 沒有開放這一步的 API)。');
  }

  return { done: done, manual: manual };
}


// ╔═══ Master.gs ═══

/**
 * Master.gs — 主控表:公司清單、管理員、邀請碼
 */

function masterSs_() {
  const id = CONFIG.masterId;
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('尚未設定 MASTER_SPREADSHEET_ID');
}

function mSheet_(name) {
  const ss = masterSs_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (M_HEADERS[name]) {
      sh.getRange(1, 1, 1, M_HEADERS[name].length).setValues([M_HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

/** 讀整張表為物件陣列(第一列當欄名),`_row` 是實際列號 */
function readSheet_(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  return values.slice(1).map((row, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, c) => { if (h !== '') o[h] = row[c]; });
    return o;
  });
}

// ─────────────────────────── 平台初始化 ───────────────────────────

/**
 * 安裝用:在主控表上執行一次。
 * 會建好主控表所有分頁,並產生 SETUP_CODE 與 WEBHOOK_TOKEN。
 */
function setupPlatform() {
  const ss = masterSs_();
  if (!CONFIG.masterId) PROP.setProperty('MASTER_SPREADSHEET_ID', ss.getId());

  Object.keys(M_HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = M_HEADERS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, head.length);
  });

  if (!PROP.getProperty('SETUP_CODE'))    PROP.setProperty('SETUP_CODE', randomCode_(10));
  if (!PROP.getProperty('WEBHOOK_TOKEN')) PROP.setProperty('WEBHOOK_TOKEN', Utilities.getUuid().replace(/-/g, ''));
  CONFIG.sessionSecret; // 觸發產生

  const msg =
    '平台初始化完成\n\n' +
    '主控表 ID:' + ss.getId() + '\n' +
    '首次啟用碼 SETUP_CODE:' + PROP.getProperty('SETUP_CODE') + '\n' +
    'WEBHOOK_TOKEN:' + PROP.getProperty('WEBHOOK_TOKEN') + '\n\n' +
    '請用「首次啟用碼」在後台完成第一位平台管理員的登記。';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 非 UI 環境 */ }
  return msg;
}

/**
 * 設定後台管理用的 Telegram bot。
 * 執行前請先在「專案設定 → 指令碼屬性」填好:
 *   ADMIN_BOT_TOKEN  向 @BotFather 申請的管理 bot token
 *   PAGE_BASE_URL    後台網頁所在資料夾,例如 https://你的帳號.github.io/punch
 * 執行後,在該 bot 的聊天室按輸入框旁的選單按鈕就能開啟後台。
 */
function setupAdminBot() {
  const token = PROP.getProperty('ADMIN_BOT_TOKEN');
  if (!token) throw new Error('請先在指令碼屬性設定 ADMIN_BOT_TOKEN');
  const base = pageBaseUrl_();
  if (!base) throw new Error('請先在指令碼屬性設定 PAGE_BASE_URL');

  const me = tgGetMe_(token);
  if (!me.ok) throw new Error(me.message);

  const btn = tgSetMenuButton_(token, base + '/admin.html');
  if (!btn.ok) throw new Error('設定選單按鈕失敗:' + btn.message);

  PROP.setProperty('ADMIN_PLATFORM', 'telegram');

  const msg = `後台 bot 設定完成:@${me.username}\n\n` +
              '請到 Telegram 找這個 bot,點輸入框旁邊的選單按鈕開啟後台。\n' +
              '記得 admin.html 最上面的 ADMIN_PLATFORM 要設成 telegram。';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 非 UI 環境 */ }
  return msg;
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('打卡平台')
      .addItem('① 初始化平台', 'setupPlatform')
      .addItem('② 設定後台 Telegram bot', 'setupAdminBot')
      .addItem('③ 安裝月底排程', 'installTriggers')
      .addSeparator()
      .addItem('顯示平台資訊', 'showPlatformInfo')
      .addItem('立即補跑上月月報', 'runLastMonthEnd')
      .addToUi();
  } catch (e) { /* noop */ }
}

function showPlatformInfo() {
  const companies = listCompanies_();
  const lines = [
    '主控表 ID:' + (CONFIG.masterId || '(未設定)'),
    'SETUP_CODE:' + (CONFIG.setupCode || '(未產生)'),
    'WEBHOOK_TOKEN:' + (CONFIG.webhookToken ? '已設定' : '(未產生)'),
    '',
    '公司數:' + companies.length,
  ].concat(companies.map(c => {
    const bot = getBot_(c.code);
    return `  ${c.code}  ${c.name}  [${c.status}]  ` +
           `${PLATFORM_LABEL[bot.platform] || bot.platform}:${botReady_(bot) ? '已設定' : '未設定'}`;
  }));
  SpreadsheetApp.getUi().alert(lines.join('\n'));
}

/** 產生好念、不易看錯的隨機碼(去掉 I O 0 1) */
function randomCode_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

// ─────────────────────────── 公司 ───────────────────────────

function rowToCompany_(r) {
  return {
    code:          String(r['公司代碼']).trim().toUpperCase(),
    name:          String(r['公司名稱'] || ''),
    platform:      String(r['平台'] || PLATFORM.LINE).trim().toLowerCase(),
    spreadsheetId: String(r['試算表ID'] || '').trim(),
    status:        String(r['狀態'] || '啟用'),
    createdAt:     r['建立時間'] || '',
    note:          String(r['備註'] || ''),
    _row:          r._row,
  };
}

/** 沒指定公司代碼時自動編一個沒用過的 */
function nextCompanyCode_() {
  const used = {};
  listCompanies_().forEach(c => { used[c.code] = 1; });
  for (let i = 1; i < 1000; i++) {
    const code = 'C' + ('0' + i).slice(-2);
    if (!used[code]) return code;
  }
  throw new Error('公司代碼已用盡,請手動指定');
}

function listCompanies_() {
  return readSheet_(mSheet_(M.COMPANY))
    .filter(r => String(r['公司代碼']).trim() !== '')
    .map(rowToCompany_);
}

function getCompany_(code) {
  const target = String(code || '').trim().toUpperCase();
  if (!target) return null;
  return listCompanies_().find(c => c.code === target) || null;
}

/**
 * 新增公司。沒給 spreadsheetId 就自動建一份新的試算表並初始化。
 */
function createCompany_(code, name, platform, spreadsheetId) {
  const clean = String(code || '').trim().toUpperCase() || nextCompanyCode_();
  if (!/^[A-Z0-9_-]{2,20}$/.test(clean)) {
    throw new Error('公司代碼只能用英文、數字、- 或 _,長度 2–20 個字');
  }
  if (getCompany_(clean)) throw new Error('公司代碼「' + clean + '」已存在');

  const plat = platform === PLATFORM.TELEGRAM ? PLATFORM.TELEGRAM : PLATFORM.LINE;

  let ssId = String(spreadsheetId || '').trim();
  if (ssId) {
    SpreadsheetApp.openById(ssId); // 存取不到會直接丟錯
  } else {
    ssId = SpreadsheetApp.create('打卡系統 - ' + name).getId();
  }
  setupCompanySheets_(ssId, name);

  mSheet_(M.COMPANY).appendRow([clean, name, plat, ssId, '啟用', new Date(), '']);
  SpreadsheetApp.flush();
  logEvent_('INFO', 'createCompany', `${clean} / ${name} / ${plat}`);
  return getCompany_(clean);
}

function updateCompany_(code, patch) {
  const co = getCompany_(code);
  if (!co) throw new Error('找不到公司:' + code);
  const sh = mSheet_(M.COMPANY);
  const head = M_HEADERS[M.COMPANY];
  if (patch.name     != null) sh.getRange(co._row, head.indexOf('公司名稱') + 1).setValue(patch.name);
  if (patch.platform != null) sh.getRange(co._row, head.indexOf('平台') + 1).setValue(patch.platform);
  if (patch.status   != null) sh.getRange(co._row, head.indexOf('狀態') + 1).setValue(patch.status);
  if (patch.note     != null) sh.getRange(co._row, head.indexOf('備註') + 1).setValue(patch.note);
  SpreadsheetApp.flush();
  return getCompany_(code);
}

// ─────────────────────────── 管理員 ───────────────────────────

function rowToAdmin_(r) {
  return {
    userId:      String(r['LINE_UserID']).trim(),
    name:        String(r['姓名'] || ''),
    role:        String(r['角色'] || ROLE.COMPANY),
    companyCode: String(r['公司代碼'] || '').trim().toUpperCase(),
    status:      String(r['狀態'] || '啟用'),
    _row:        r._row,
  };
}

function listAdmins_() {
  return readSheet_(mSheet_(M.ADMIN))
    .filter(r => String(r['LINE_UserID']).trim() !== '')
    .map(rowToAdmin_);
}

function getAdmin_(userId) {
  if (!userId) return null;
  const a = listAdmins_().find(x => x.userId === userId);
  return a && a.status === '啟用' ? a : null;
}

function addAdmin_(userId, name, role, companyCode) {
  const existing = listAdmins_().find(x => x.userId === userId);
  const sh = mSheet_(M.ADMIN);
  const head = M_HEADERS[M.ADMIN];
  if (existing) {
    sh.getRange(existing._row, 1, 1, head.length)
      .setValues([[userId, name || existing.name, role, companyCode || '', '啟用', new Date()]]);
  } else {
    sh.appendRow([userId, name || '', role, companyCode || '', '啟用', new Date()]);
  }
  SpreadsheetApp.flush();
  return getAdmin_(userId);
}

// ─────────────────────────── 邀請碼 ───────────────────────────

function createInvite_(role, companyCode, days) {
  const code = randomCode_(8);
  const exp = new Date(Date.now() + (days || 7) * 86400000);
  mSheet_(M.INVITE).appendRow([code, role, companyCode || '', exp, 'FALSE', '', new Date()]);
  SpreadsheetApp.flush();
  return { code: code, role: role, companyCode: companyCode || '', expiresAt: exp };
}

/**
 * 使用邀請碼,成功即把該 LINE 使用者登記為管理員。
 * @return {{ok:boolean, message:string, admin?:Object}}
 */
function useInvite_(code, userId, displayName) {
  const target = String(code || '').trim().toUpperCase();
  if (!target) return { ok: false, message: '請輸入邀請碼' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = mSheet_(M.INVITE);
    const head = M_HEADERS[M.INVITE];
    const rows = readSheet_(sh);
    const hit = rows.find(r => String(r['邀請碼']).trim().toUpperCase() === target);

    if (!hit) return { ok: false, message: '邀請碼不存在' };
    if (String(hit['已使用']).toUpperCase() === 'TRUE') return { ok: false, message: '這組邀請碼已經被使用過了' };
    if (hit['到期時間'] instanceof Date && hit['到期時間'] < new Date()) {
      return { ok: false, message: '邀請碼已過期,請向平台管理員重新索取' };
    }

    const role = String(hit['角色'] || ROLE.COMPANY);
    const companyCode = String(hit['公司代碼'] || '').trim().toUpperCase();
    if (role === ROLE.COMPANY && !getCompany_(companyCode)) {
      return { ok: false, message: '邀請碼對應的公司不存在' };
    }

    const admin = addAdmin_(userId, displayName, role, companyCode);
    sh.getRange(hit._row, head.indexOf('已使用') + 1).setValue('TRUE');
    sh.getRange(hit._row, head.indexOf('使用者') + 1).setValue(displayName || userId);
    SpreadsheetApp.flush();

    return { ok: true, message: '已加入管理後台', admin: admin };
  } finally {
    lock.releaseLock();
  }
}

function listInvites_(companyCode) {
  return readSheet_(mSheet_(M.INVITE))
    .filter(r => String(r['邀請碼']).trim() !== '')
    .filter(r => !companyCode || String(r['公司代碼']).trim().toUpperCase() === String(companyCode).toUpperCase())
    .map(r => ({
      code: String(r['邀請碼']),
      role: String(r['角色']),
      companyCode: String(r['公司代碼'] || ''),
      expiresAt: r['到期時間'] instanceof Date ? Utilities.formatDate(r['到期時間'], CONFIG.TZ, 'yyyy/MM/dd') : '',
      used: String(r['已使用']).toUpperCase() === 'TRUE',
      usedBy: String(r['使用者'] || ''),
    }))
    .reverse()
    .slice(0, 30);
}

// ─────────────────────────── 系統紀錄 ───────────────────────────

function logEvent_(level, source, message) {
  try {
    mSheet_(M.LOG).appendRow([new Date(), level, source, String(message).slice(0, 2000)]);
  } catch (err) {
    console.error('logEvent_ failed: ' + err);
  }
}


// ╔═══ Tenant.gs ═══

/**
 * Tenant.gs — 單一公司試算表的存取
 *
 * 所有函式都接受一個 tenant 物件(由 tenant_() 產生),
 * 確保每一次讀寫都明確綁定在某一家公司上,不會跨公司污染。
 */

/** @return {{code:string, name:string, ss:Spreadsheet}} */
function tenant_(companyCode) {
  const co = getCompany_(companyCode);
  if (!co) throw new Error('找不到公司代碼:' + companyCode);
  if (co.status !== '啟用') throw new Error('公司「' + co.name + '」目前為停用狀態');
  if (!co.spreadsheetId) throw new Error('公司「' + co.name + '」尚未設定試算表');
  return { code: co.code, name: co.name, ss: SpreadsheetApp.openById(co.spreadsheetId) };
}

function tSheet_(t, name) {
  let sh = t.ss.getSheetByName(name);
  if (!sh) {
    sh = t.ss.insertSheet(name);
    if (HEADERS[name]) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  }
  return sh;
}

function tRead_(t, name) {
  return readSheet_(tSheet_(t, name));
}

// ─────────────────────────── 建立公司試算表 ───────────────────────────

function setupCompanySheets_(spreadsheetId, companyName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);

  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = HEADERS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head])
      .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, head.length);
  });

  const setting = ss.getSheetByName(SHEETS.SETTING);
  if (setting.getLastRow() < 2) {
    setting.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  }

  const leaveType = ss.getSheetByName(SHEETS.LEAVETYPE);
  if (leaveType.getLastRow() < 2) {
    leaveType.getRange(2, 1, DEFAULT_LEAVE_TYPES.length, HEADERS[SHEETS.LEAVETYPE].length)
      .setValues(DEFAULT_LEAVE_TYPES);
  }

  const rules = ss.getSheetByName(SHEETS.RULES);
  if (rules.getLastRow() < 2) {
    rules.getRange(2, 1, DEFAULT_RULES.length, HEADERS[SHEETS.RULES].length).setValues(DEFAULT_RULES);
    rules.getRange(2, 3, DEFAULT_RULES.length, 1).setWrap(true);
    rules.setColumnWidth(3, 520);
  }

  const rec = ss.getSheetByName(SHEETS.RECORD);
  rec.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  rec.getRange('B:B').setNumberFormat('yyyy/mm/dd');

  const lv = ss.getSheetByName(SHEETS.LEAVE);
  lv.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  lv.getRange('G:G').setNumberFormat('yyyy/mm/dd');
  lv.getRange('I:I').setNumberFormat('yyyy/mm/dd');
  lv.getRange('O:O').setNumberFormat('yyyy/mm/dd hh:mm:ss');

  // 移除自動產生的空白「工作表1」
  const blank = ss.getSheets().find(s => /^(工作表1|Sheet1)$/.test(s.getName()) && s.getLastRow() === 0);
  if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);

  SpreadsheetApp.flush();
  return spreadsheetId;
}

// ─────────────────────────── 設定 ───────────────────────────

function tSetting_(t, key, fallback) {
  const rows = tRead_(t, SHEETS.SETTING);
  const hit = rows.find(r => String(r['項目']).trim() === key);
  if (!hit || hit['值'] === '' || hit['值'] == null) return fallback;
  return hit['值'];
}

function tSettingNumber_(t, key, fallback) {
  const v = Number(tSetting_(t, key, fallback));
  return isNaN(v) ? fallback : v;
}

function tSettingBool_(t, key, fallback) {
  const v = tSetting_(t, key, fallback);
  if (typeof v === 'boolean') return v;
  return String(v).trim().toUpperCase() === 'TRUE';
}

/** 整批寫入設定,沒有的項目會新增一列 */
function tSaveSettings_(t, items) {
  const sh = tSheet_(t, SHEETS.SETTING);
  const rows = readSheet_(sh);
  items.forEach(item => {
    const key = String(item.key).trim();
    const hit = rows.find(r => String(r['項目']).trim() === key);
    if (hit) {
      sh.getRange(hit._row, 2).setValue(item.value);
    } else {
      sh.appendRow([key, item.value, '']);
    }
  });
  SpreadsheetApp.flush();
}

/** 把 '09:00' 或 Date 轉成 {h, m} */
function parseHHmm_(v, fh, fm) {
  if (v instanceof Date) return { h: v.getHours(), m: v.getMinutes() };
  const m = String(v).trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: fh, m: fm };
}

function fmtHHmm_(t, key, fh, fm) {
  const x = parseHHmm_(tSetting_(t, key, ''), fh, fm);
  return ('0' + x.h).slice(-2) + ':' + ('0' + x.m).slice(-2);
}

// ─────────────────────────── 允許網段 ───────────────────────────

function tAllowRules_(t) {
  return tRead_(t, SHEETS.ALLOWIP)
    .filter(r => String(r['規則']).trim() !== '')
    .filter(r => String(r['啟用']).trim().toUpperCase() === 'TRUE')
    .map(r => ({ rule: String(r['規則']).trim(), location: String(r['地點名稱'] || '公司').trim() }));
}

function tListIps_(t) {
  return tRead_(t, SHEETS.ALLOWIP)
    .filter(r => String(r['規則']).trim() !== '')
    .map(r => ({
      rule: String(r['規則']).trim(),
      location: String(r['地點名稱'] || ''),
      enabled: String(r['啟用']).trim().toUpperCase() === 'TRUE',
      note: String(r['說明'] || ''),
    }));
}

/** 整批覆寫允許網段(資料量小,直接重寫最單純) */
function tSaveIps_(t, rows) {
  const sh = tSheet_(t, SHEETS.ALLOWIP);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, HEADERS[SHEETS.ALLOWIP].length).clearContent();
  const clean = (rows || [])
    .filter(r => String(r.rule || '').trim() !== '')
    .map(r => [String(r.rule).trim(), String(r.location || '公司'), r.enabled ? 'TRUE' : 'FALSE', String(r.note || '')]);
  if (clean.length) sh.getRange(2, 1, clean.length, 4).setValues(clean);
  SpreadsheetApp.flush();
  return clean.length;
}

// ─────────────────────────── 員工 ───────────────────────────

function tListEmployees_(t) {
  return tRead_(t, SHEETS.EMPLOYEE)
    .filter(r => String(r['員工編號']).trim() !== '' || String(r['平台UserID']).trim() !== '')
    .map(r => ({
      code:    String(r['員工編號']).trim(),
      name:    String(r['姓名'] || ''),
      dept:    String(r['部門'] || ''),
      bound:   String(r['平台UserID']).trim() !== '',
      userId:  String(r['平台UserID']).trim(),
      lineName:String(r['暱稱'] || ''),
      status:  String(r['狀態'] || EMP_STATUS.ACTIVE),
      pending: String(r['狀態'] || '').trim() === EMP_STATUS.PENDING,
      boundAt: r['綁定時間'] instanceof Date ? Utilities.formatDate(r['綁定時間'], CONFIG.TZ, 'yyyy/MM/dd HH:mm') : '',
      note:    String(r['備註'] || ''),
    }))
    .sort((a, b) => (a.pending === b.pending) ? (a.code < b.code ? -1 : 1) : (a.pending ? -1 : 1));
}

/**
 * 員工只傳「綁定」時走這裡:先把 Telegram 身分記下來,
 * 姓名與員工編號留白,等管理員在後台補。
 * @return {{ok:boolean, message:string, already?:boolean}}
 */
function tRegisterPending_(t, userId, displayName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existing = tFindEmployeeByUserId_(t, userId);
    if (existing) {
      const status = String(existing['狀態'] || '').trim();
      if (status === EMP_STATUS.PENDING) {
        return { ok: true, already: true,
                 message: '你已經送出綁定了,正在等管理員設定你的資料。設定好會通知你。' };
      }
      return { ok: true, already: true,
               message: `你已經綁定完成了。\n姓名:${existing['姓名']}\n員工編號:${existing['員工編號']}` };
    }

    const sh = tSheet_(t, SHEETS.EMPLOYEE);
    sh.appendRow(['', '', '', userId, displayName || '', EMP_STATUS.PENDING, new Date(), '員工自行綁定,待管理員設定']);
    SpreadsheetApp.flush();

    return { ok: true, message: '已送出綁定申請,等管理員設定你的資料。設定完成會通知你。' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 管理員設定「待設定」的員工是誰。用平台 UserID 認人,因為那時候還沒有員工編號。
 * @return {{ok:boolean, message:string, employee?:Object}}
 */
function tAssignEmployee_(t, userId, emp) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const row = tFindEmployeeByUserId_(t, userId);
    if (!row) throw new Error('找不到這個綁定紀錄,可能已被刪除');

    const code = String(emp.code || '').trim();
    const name = String(emp.name || '').trim();
    if (!code) throw new Error('請填員工編號');
    if (!name) throw new Error('請填姓名');

    const clash = tFindEmployeeByCode_(t, code);
    if (clash && clash._row !== row._row) {
      throw new Error(`員工編號「${code}」已經被 ${clash['姓名'] || '其他人'} 使用了`);
    }

    const sh = tSheet_(t, SHEETS.EMPLOYEE);
    const head = HEADERS[SHEETS.EMPLOYEE];
    sh.getRange(row._row, head.indexOf('員工編號') + 1).setValue(code);
    sh.getRange(row._row, head.indexOf('姓名') + 1).setValue(name);
    sh.getRange(row._row, head.indexOf('部門') + 1).setValue(emp.dept || '');
    sh.getRange(row._row, head.indexOf('狀態') + 1).setValue(emp.status || EMP_STATUS.ACTIVE);
    sh.getRange(row._row, head.indexOf('備註') + 1).setValue(emp.note || '');
    SpreadsheetApp.flush();

    return { ok: true, message: `已設定 ${name}(${code})`, employee: tFindEmployeeByCode_(t, code) };
  } finally {
    lock.releaseLock();
  }
}

function tFindEmployeeByUserId_(t, lineUserId) {
  if (!lineUserId) return null;
  return tRead_(t, SHEETS.EMPLOYEE)
    .find(r => String(r['平台UserID']).trim() === lineUserId) || null;
}

function tFindEmployeeByCode_(t, code) {
  const target = String(code || '').trim().toUpperCase();
  if (!target) return null;
  return tRead_(t, SHEETS.EMPLOYEE)
    .find(r => String(r['員工編號']).trim().toUpperCase() === target) || null;
}

/** 新增或更新員工基本資料(不動 LINE 綁定欄位) */
function tUpsertEmployee_(t, emp) {
  const sh = tSheet_(t, SHEETS.EMPLOYEE);
  const head = HEADERS[SHEETS.EMPLOYEE];
  const existing = tFindEmployeeByCode_(t, emp.code);
  if (existing) {
    sh.getRange(existing._row, head.indexOf('姓名') + 1).setValue(emp.name);
    sh.getRange(existing._row, head.indexOf('部門') + 1).setValue(emp.dept || '');
    sh.getRange(existing._row, head.indexOf('狀態') + 1).setValue(emp.status || '在職');
    sh.getRange(existing._row, head.indexOf('備註') + 1).setValue(emp.note || '');
  } else {
    sh.appendRow([String(emp.code).trim(), emp.name, emp.dept || '', '', '', emp.status || '在職', '', emp.note || '']);
  }
  SpreadsheetApp.flush();
}

function tUnbindEmployee_(t, code) {
  const sh = tSheet_(t, SHEETS.EMPLOYEE);
  const head = HEADERS[SHEETS.EMPLOYEE];
  const emp = tFindEmployeeByCode_(t, code);
  if (!emp) throw new Error('找不到員工編號:' + code);
  sh.getRange(emp._row, head.indexOf('平台UserID') + 1).setValue('');
  sh.getRange(emp._row, head.indexOf('暱稱') + 1).setValue('');
  sh.getRange(emp._row, head.indexOf('綁定時間') + 1).setValue('');
  SpreadsheetApp.flush();
}

/** 刪除一筆還沒設定的綁定(那時候還沒有員工編號,只能用 UserID 認) */
function tDeletePendingByUserId_(t, userId) {
  const row = tFindEmployeeByUserId_(t, userId);
  if (!row) throw new Error('找不到這筆綁定紀錄');
  if (String(row['員工編號']).trim()) {
    throw new Error('這筆已經設定過員工編號了,請用名冊裡的「刪除」');
  }
  tSheet_(t, SHEETS.EMPLOYEE).deleteRow(row._row);
  SpreadsheetApp.flush();
}

function tDeleteEmployee_(t, code) {
  const emp = tFindEmployeeByCode_(t, code);
  if (!emp) throw new Error('找不到員工編號:' + code);
  tSheet_(t, SHEETS.EMPLOYEE).deleteRow(emp._row);
  SpreadsheetApp.flush();
}

/** 員工自行綁定 LINE 帳號 */
function tBindEmployee_(t, code, lineUserId, displayName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const emp = tFindEmployeeByCode_(t, code);
    if (!emp) return { ok: false, message: `在${t.name}找不到員工編號「${code}」,請確認後再試,或聯絡管理員。` };

    const status = String(emp['狀態']).trim();
    if (status && status !== '在職') {
      return { ok: false, message: `員工編號「${code}」目前狀態為「${status}」,無法綁定。` };
    }

    const existing = String(emp['平台UserID']).trim();
    if (existing && existing !== lineUserId) {
      return { ok: false, message: `員工編號「${code}」已被其他 LINE 帳號綁定,請聯絡管理員解除。` };
    }

    const dup = tRead_(t, SHEETS.EMPLOYEE).find(r =>
      String(r['平台UserID']).trim() === lineUserId &&
      String(r['員工編號']).trim().toUpperCase() !== String(code).trim().toUpperCase());
    if (dup) {
      return { ok: false, message: `你的 LINE 帳號已綁定員工編號「${dup['員工編號']}」,請先聯絡管理員解除。` };
    }

    const sh = tSheet_(t, SHEETS.EMPLOYEE);
    const head = HEADERS[SHEETS.EMPLOYEE];
    sh.getRange(emp._row, head.indexOf('平台UserID') + 1).setValue(lineUserId);
    sh.getRange(emp._row, head.indexOf('暱稱') + 1).setValue(displayName || '');
    sh.getRange(emp._row, head.indexOf('綁定時間') + 1).setValue(new Date());
    SpreadsheetApp.flush();

    return { ok: true, message: `綁定成功!${emp['姓名']}(${emp['員工編號']})`, name: String(emp['姓名']) };
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────── 打卡紀錄 ───────────────────────────

function tAppendRecord_(t, rec) {
  tSheet_(t, SHEETS.RECORD).appendRow([
    rec.timestamp, rec.date, rec.time,
    rec.code, rec.name, rec.dept,
    rec.type, rec.judgement, rec.location,
    rec.ip, rec.ipVerified,
    rec.ua, rec.note || '',
  ]);
}

function tRecordsOfDay_(t, empCode, date) {
  const key = Utilities.formatDate(date, CONFIG.TZ, 'yyyy/MM/dd');
  return tRead_(t, SHEETS.RECORD)
    .filter(r => String(r['員工編號']).trim().toUpperCase() === String(empCode).trim().toUpperCase())
    .filter(r => r['日期'] instanceof Date && Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM/dd') === key)
    .sort((a, b) => new Date(a['時間戳記']) - new Date(b['時間戳記']));
}

/** 依日期區間與員工查詢紀錄 */
function tQueryRecords_(t, fromStr, toStr, empCode) {
  const from = fromStr ? new Date(fromStr + 'T00:00:00') : null;
  const to   = toStr   ? new Date(toStr   + 'T23:59:59') : null;
  const emp  = empCode ? String(empCode).trim().toUpperCase() : '';

  return tRead_(t, SHEETS.RECORD)
    .filter(r => r['時間戳記'] instanceof Date)
    .filter(r => !from || r['時間戳記'] >= from)
    .filter(r => !to   || r['時間戳記'] <= to)
    .filter(r => !emp  || String(r['員工編號']).trim().toUpperCase() === emp)
    .sort((a, b) => b['時間戳記'] - a['時間戳記'])
    .slice(0, 1000)
    .map(r => ({
      datetime:  Utilities.formatDate(r['時間戳記'], CONFIG.TZ, 'yyyy/MM/dd HH:mm'),
      code:      String(r['員工編號']),
      name:      String(r['姓名']),
      dept:      String(r['部門'] || ''),
      type:      String(r['類型']),
      judgement: String(r['判定']),
      location:  String(r['地點'] || ''),
      ip:        String(r['來源IP'] || ''),
      device:    String(r['裝置'] || ''),
    }));
}

function fmtTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TZ, 'HH:mm');
  const d = new Date(v);
  return isNaN(d) ? String(v) : Utilities.formatDate(d, CONFIG.TZ, 'HH:mm');
}


// ╔═══ Ip.gs ═══

/**
 * Ip.gs — 來源 IP 比對
 *
 * 支援四種規則寫法(IPv4):
 *   203.0.113.45                 單一 IP
 *   203.0.113.0/24               CIDR 網段
 *   203.0.113.*                  萬用字元
 *   203.0.113.10-203.0.113.20    起訖範圍
 * IPv6 僅支援完全相同字串比對。
 */

function normalizeIp_(ip) {
  return String(ip == null ? '' : ip).trim().toLowerCase().replace(/^::ffff:/, '');
}

function ipv4ToLong_(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const s of parts) {
    if (!/^\d{1,3}$/.test(s)) return null;
    const v = Number(s);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function ipMatches_(ip, rule) {
  ip = normalizeIp_(ip);
  rule = normalizeIp_(rule);
  if (!ip || !rule) return false;
  if (rule === '*') return true;

  if (rule.indexOf('/') !== -1) {
    const seg = rule.split('/');
    const bits = Number(seg[1]);
    const a = ipv4ToLong_(ip);
    const b = ipv4ToLong_(seg[0]);
    if (a === null || b === null || isNaN(bits) || bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((a & mask) >>> 0) === ((b & mask) >>> 0);
  }

  if (rule.indexOf('-') !== -1) {
    const seg = rule.split('-');
    const a = ipv4ToLong_(ip);
    const s = ipv4ToLong_(seg[0].trim());
    const e = ipv4ToLong_(seg[1].trim());
    if (a === null || s === null || e === null) return false;
    return a >= Math.min(s, e) && a <= Math.max(s, e);
  }

  if (rule.indexOf('*') !== -1) {
    const pattern = rule.split('.')
      .map(s => (s === '*' ? '\\d{1,3}' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('\\.');
    return new RegExp('^' + pattern + '$').test(ip);
  }

  return ip === rule;
}

/**
 * 判斷是否為「可能出現在網際網路上的來源位址」。
 *
 * 對外 IP 依定義一定是公網位址。如果前端回報的是 192.168.x 這類內網位址,
 * 代表不是真的對外 IP —— 可能是有人手動塞值,也可能是設定錯誤,
 * 兩種情況都不該讓它通過打卡。
 */
function isPublicIp_(ip) {
  const s = normalizeIp_(ip);
  if (!s) return false;

  const n = ipv4ToLong_(s);
  if (n === null) {
    // IPv6:排除回送、唯一本地位址(ULA)、鏈路本地
    if (s === '::1' || s === '::') return false;
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return false;
    if (/^fe[89ab][0-9a-f]:/.test(s)) return false;
    return s.indexOf(':') !== -1;
  }

  const inRange = (base, bits) => {
    const b = ipv4ToLong_(base);
    const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  };

  return !(inRange('0.0.0.0', 8)       ||  // 本網路
           inRange('10.0.0.0', 8)      ||  // 私有
           inRange('100.64.0.0', 10)   ||  // 電信業者 CGNAT
           inRange('127.0.0.0', 8)     ||  // 回送
           inRange('169.254.0.0', 16)  ||  // 鏈路本地
           inRange('172.16.0.0', 12)   ||  // 私有
           inRange('192.168.0.0', 16)  ||  // 私有
           inRange('224.0.0.0', 4)     ||  // 多播
           inRange('240.0.0.0', 4));       // 保留
}

/**
 * 檢查一組候選 IP 是否落在該公司的允許網段內。
 *
 * 三種可信度(會寫進打卡紀錄,勞檢或爭議時看得出證據強度):
 *   worker — 經 Cloudflare Worker,IP 取自連線本身,員工無法偽造
 *   client — 由打卡頁回報,一般員工做不到,但技術上可偽造
 *   off    — 該公司關閉了 IP 驗證(測試模式)
 *
 * @param {Object} t tenant
 * @param {string[]} ips
 * @return {{allowed:boolean, ip:string, rule:string, location:string,
 *           enforced:boolean, trust:string, trustLabel:string, reason:string}}
 */
function tCheckIps_(t, ips) {
  const raw = (ips || []).map(normalizeIp_).filter(Boolean);
  const trust = CONFIG.trustProxy ? 'worker' : 'client';
  const trustLabel = { worker: 'Worker驗證', client: '前端回報', off: '已停用驗證' };
  const enforced = tSettingBool_(t, '啟用IP驗證', true);

  if (!enforced) {
    return {
      allowed: true, ip: raw.join(', '), rule: '(已停用IP驗證)', location: '未限制',
      enforced: false, trust: 'off', trustLabel: trustLabel.off, reason: '',
    };
  }

  const base = {
    allowed: false, rule: '', location: '',
    enforced: true, trust: trust, trustLabel: trustLabel[trust], reason: '',
  };

  if (!raw.length) {
    return Object.assign({}, base, { ip: '', reason: 'NO_IP' });
  }

  // 內網位址不可能是對外 IP,直接淘汰
  const list = raw.filter(isPublicIp_);
  if (!list.length) {
    return Object.assign({}, base, { ip: raw.join(', '), reason: 'PRIVATE_IP' });
  }

  const rules = tAllowRules_(t);
  if (!rules.length) {
    return Object.assign({}, base, { ip: list.join(', '), reason: 'NO_RULE' });
  }

  for (const r of rules) {
    for (const ip of list) {
      if (ipMatches_(ip, r.rule)) {
        return {
          allowed: true, ip: ip, rule: r.rule, location: r.location,
          enforced: true, trust: trust, trustLabel: trustLabel[trust], reason: '',
        };
      }
    }
  }
  return Object.assign({}, base, { ip: list.join(', '), reason: 'NOT_IN_RANGE' });
}

/** 失敗的一句話標題,直接顯示在「打卡失敗」下面 */
function ipDeniedTitle_(check) {
  switch (check.reason) {
    case 'NO_IP':      return '無法取得網路位置';
    case 'PRIVATE_IP': return 'IP 不符合(偵測到內網位址)';
    case 'NO_RULE':    return '公司尚未設定允許的網路位置';
    default:           return 'IP 不符合';
  }
}

/** 失敗的處理建議 */
function ipDeniedMessage_(check) {
  switch (check.reason) {
    case 'NO_IP':
      return '請確認手機已連上公司 Wi-Fi,然後重新偵測。';
    case 'PRIVATE_IP':
      return '請關閉 VPN 或 Proxy,直接連公司 Wi-Fi 後重試。';
    case 'NO_RULE':
      return '請聯絡管理員設定公司的允許網段。';
    default:
      return '你必須人在公司現場、連上公司 Wi-Fi 才能打卡。\n請關閉行動網路,改連公司 Wi-Fi 後再試一次。';
  }
}


// ╔═══ Line.gs ═══

/**
 * Line.gs — LINE Platform API(每家公司各自的 channel)
 */

/**
 * 驗證 LIFF 送來的 ID Token,取得可信任的 LINE userId。
 * 前端可以偽造 userId,但偽造不出 LINE 簽章過的 idToken。
 */
function lineVerifyIdToken_(idToken, loginChannelId) {
  if (!idToken) return { ok: false, error: '缺少 idToken' };
  if (!loginChannelId) return { ok: false, error: '尚未設定 LINE Login Channel ID' };

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { id_token: idToken, client_id: String(loginChannelId) },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  let body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* noop */ }

  if (code !== 200) return { ok: false, error: body.error_description || body.error || ('HTTP ' + code) };
  if (!body.sub)    return { ok: false, error: 'idToken 中沒有 sub' };

  return { ok: true, userId: body.sub, displayName: body.name || '' };
}

// ─────────────────────────── Messaging API ───────────────────────────

function lineApi_(companyCode, path, payload) {
  const token = getBot_(companyCode).channelAccessToken;
  if (!token) {
    logEvent_('WARN', 'lineApi_', companyCode + ' 未設定 channel access token,略過 ' + path);
    return null;
  }
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    logEvent_('WARN', 'lineApi_', `${companyCode} ${path} → ${res.getResponseCode()} ${res.getContentText()}`);
  }
  return res;
}

function lineReply_(companyCode, replyToken, messages) {
  if (!replyToken) return;
  lineApi_(companyCode, 'message/reply', { replyToken: replyToken, messages: [].concat(messages) });
}

function linePush_(companyCode, to, messages) {
  if (!to) return;
  lineApi_(companyCode, 'message/push', { to: to, messages: [].concat(messages) });
}

function lineProfile_(companyCode, userId) {
  const token = getBot_(companyCode).channelAccessToken;
  if (!userId || !token) return {};
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + userId, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : {};
  } catch (e) {
    return {};
  }
}

/** 驗證 channel access token 是否可用(後台存檔時檢查) */
function lineCheckToken_(token) {
  if (!token) return { ok: false, message: '未提供 token' };
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    return { ok: false, message: 'Token 無效(HTTP ' + res.getResponseCode() + ')' };
  }
  const info = JSON.parse(res.getContentText());
  return { ok: true, displayName: info.displayName || '', basicId: info.basicId || '' };
}

// ─────────────────────────── LIFF 自動建立 ───────────────────────────

/** 用 Login channel 的 ID + secret 換一組短期存取權杖(LIFF Server API 用) */
function lineLoginChannelToken_(channelId, channelSecret) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/oauth/accessToken', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: { grant_type: 'client_credentials', client_id: String(channelId), client_secret: String(channelSecret) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    return { ok: false, message: 'Login channel 憑證錯誤(HTTP ' + res.getResponseCode() + ')' };
  }
  return { ok: true, token: JSON.parse(res.getContentText()).access_token };
}

/**
 * 自動建立 LIFF App,省掉手動貼 Endpoint URL 這個最容易出錯的步驟。
 * @return {{ok:boolean, liffId?:string, message?:string}}
 */
function lineCreateLiff_(channelId, channelSecret, endpointUrl, description) {
  const t = lineLoginChannelToken_(channelId, channelSecret);
  if (!t.ok) return { ok: false, message: t.message };

  const res = UrlFetchApp.fetch('https://api.line.me/liff/v1/apps', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + t.token },
    payload: JSON.stringify({
      view: { type: 'full', url: endpointUrl },
      description: String(description || '打卡').slice(0, 100),
      features: { ble: false },
      scope: ['profile', 'openid'],
      botPrompt: 'aggressive',
    }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() >= 300) {
    return { ok: false, message: 'HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200) };
  }
  const liffId = JSON.parse(res.getContentText()).liffId;
  return liffId ? { ok: true, liffId: liffId } : { ok: false, message: '回應中沒有 liffId' };
}

/** 更新既有 LIFF 的 Endpoint URL(打卡頁換網址時用) */
function lineUpdateLiff_(channelId, channelSecret, liffId, endpointUrl) {
  const t = lineLoginChannelToken_(channelId, channelSecret);
  if (!t.ok) return { ok: false, message: t.message };

  const res = UrlFetchApp.fetch('https://api.line.me/liff/v1/apps/' + liffId, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + t.token },
    payload: JSON.stringify({ view: { type: 'full', url: endpointUrl } }),
    muteHttpExceptions: true,
  });
  return res.getResponseCode() < 300
    ? { ok: true }
    : { ok: false, message: 'HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200) };
}

// ─────────────────────────── 訊息 ───────────────────────────

function textMsg_(text) {
  return { type: 'text', text: String(text).slice(0, 4900) };
}

function punchFlex_(r) {
  const isIn = r.type === PUNCH_IN;
  const accent = r.judgement === '正常' ? '#1DB446' : '#E8A33D';
  return {
    type: 'flex',
    altText: `${r.type}打卡成功 ${r.time}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', paddingAll: '14px',
        backgroundColor: isIn ? '#1f3864' : '#3d3d5c',
        contents: [
          { type: 'text', text: `${r.type}打卡成功`, color: '#ffffff', weight: 'bold', size: 'lg' },
          { type: 'text', text: r.companyName, color: '#c9d3ea', size: 'xs', margin: 'sm' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: [
          { type: 'text', text: r.time, size: '3xl', weight: 'bold', align: 'center', color: '#1f3864' },
          { type: 'text', text: r.dateText, size: 'sm', align: 'center', color: '#8c8c8c' },
          { type: 'separator', margin: 'md' },
          flexRow_('姓名', `${r.name}(${r.code})`),
          flexRow_('地點', r.location),
          flexRow_('判定', r.judgement, accent),
        ],
      },
    },
  };
}

function flexRow_(label, value, valueColor) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm', margin: 'md',
    contents: [
      { type: 'text', text: label, color: '#aaaaaa', size: 'sm', flex: 2 },
      { type: 'text', text: String(value), color: valueColor || '#333333', size: 'sm', flex: 5, wrap: true },
    ],
  };
}

function punchButtonMsg_(companyCode, title, text) {
  const url = punchEntryUrl_(companyCode);
  if (!url) return textMsg_(text + '\n(管理員尚未設定打卡頁)');
  return {
    type: 'template',
    altText: title,
    template: {
      type: 'buttons',
      title: String(title).slice(0, 40),
      text: String(text).slice(0, 60),
      actions: [{ type: 'uri', label: '開啟打卡頁', uri: url }],
    },
  };
}


// ╔═══ Telegram.gs ═══

/**
 * Telegram.gs — Telegram Bot API
 *
 * Telegram 只需要一個 bot token:發訊息、驗證身分、設定 webhook 全都用它。
 * 身分驗證用的是 WebApp 的 initData —— Telegram 用 bot token 對它做了 HMAC 簽章,
 * 前端改不動,所以和 LINE 的 idToken 一樣可信。
 */

function tgApi_(botToken, method, payload) {
  if (!botToken) return { ok: false, message: '未設定 bot token' };
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + botToken + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok) {
      logEvent_('WARN', 'tgApi_', method + ' → ' + res.getContentText());
      return { ok: false, message: body.description || ('HTTP ' + res.getResponseCode()) };
    }
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 驗證 token 並取得 bot 資訊 */
function tgGetMe_(botToken) {
  const r = tgApi_(botToken, 'getMe');
  if (!r.ok) return { ok: false, message: 'Bot token 無效:' + r.message };
  return { ok: true, username: r.result.username || '', name: r.result.first_name || '' };
}

function tgSend_(botToken, chatId, html) {
  return tgApi_(botToken, 'sendMessage', {
    chat_id: String(chatId),
    text: String(html).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/** 送出訊息並附上一顆開啟打卡頁的按鈕 */
function tgSendWithPunchButton_(botToken, chatId, html, webAppUrl) {
  const payload = {
    chat_id: String(chatId),
    text: String(html).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (webAppUrl) {
    payload.reply_markup = { inline_keyboard: [[{ text: '⏱ 開啟打卡頁', web_app: { url: webAppUrl } }]] };
  }
  return tgApi_(botToken, 'sendMessage', payload);
}

function tgSetWebhook_(botToken, url) {
  return tgApi_(botToken, 'setWebhook', {
    url: url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

/** 聊天室輸入框旁邊那顆按鈕,點了直接開打卡頁 */
function tgSetMenuButton_(botToken, webAppUrl) {
  return tgApi_(botToken, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: '打卡', web_app: { url: webAppUrl } },
  });
}

function tgSetCommands_(botToken) {
  return tgApi_(botToken, 'setMyCommands', {
    commands: [
      { command: 'bind',  description: '綁定員工編號,例如 /bind A001' },
      { command: 'punch', description: '開啟打卡頁' },
      { command: 'today', description: '今天的打卡紀錄' },
      { command: 'rules', description: '工作守則' },
      { command: 'leave', description: '請假申請' },
      { command: 'myleave', description: '我的請假紀錄' },
      { command: 'month', description: '本月出勤摘要' },
      { command: 'me',    description: '查看綁定資料' },
    ],
  });
}

// ─────────────────────────── initData 驗證 ───────────────────────────

/**
 * 驗證 Telegram WebApp 的 initData。
 * 依照官方規則:
 *   secret_key = HMAC_SHA256(key = "WebAppData", data = bot_token)
 *   hash       = hex(HMAC_SHA256(key = secret_key, data = data_check_string))
 * data_check_string 是除了 hash 以外的所有欄位,依 key 排序後用 \n 串起來。
 *
 * 注意兩個容易踩到的細節:
 *   1. 值要用 decodeURIComponent 還原,但「不能」把 + 換成空白 —— Telegram
 *      官方範例用的是 Python unquote(),不做 + 轉換,轉了會導致簽章對不上。
 *   2. Bot API 7.10 之後 initData 多了 signature 欄位(給第三方 Ed25519 驗證用)。
 *      官方 HMAC 範例只排除 hash,但實務上兩種版本都遇得到,所以兩種都試。
 *
 * @return {{ok:boolean, userId?:string, displayName?:string, error?:string}}
 */
function tgVerifyInitData_(botToken, initData) {
  if (!botToken) return { ok: false, error: '尚未設定 bot token' };
  if (!initData) return { ok: false, error: '缺少 initData' };

  const fields = {};
  let hash = '';
  String(initData).split('&').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i);
    let v;
    try { v = decodeURIComponent(part.slice(i + 1)); } catch (e) { v = part.slice(i + 1); }
    if (k === 'hash') hash = v; else fields[k] = v;
  });
  if (!hash) return { ok: false, error: 'initData 缺少 hash' };

  const secretKey = Utilities.computeHmacSha256Signature(botToken, 'WebAppData');
  const expected = String(hash).toLowerCase();

  const build = keys => keys.sort().map(k => k + '=' + fields[k]).join('\n');
  const candidates = [Object.keys(fields)];
  if (fields.signature !== undefined) {
    candidates.push(Object.keys(fields).filter(k => k !== 'signature'));
  }

  const matched = candidates.some(keys => {
    const sig = Utilities.computeHmacSha256Signature(
      Utilities.newBlob(build(keys)).getBytes(), secretKey);
    return safeEqual_(bytesToHex_(sig), expected);
  });
  if (!matched) return { ok: false, error: '簽章驗證失敗' };

  // 防重放:超過 24 小時的 initData 不接受
  const authDate = Number(fields.auth_date || 0);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) {
    return { ok: false, error: '登入資訊已過期,請重新開啟打卡頁' };
  }

  if (!fields.user) return { ok: false, error: 'initData 缺少 user' };
  let user;
  try { user = JSON.parse(fields.user); } catch (e) { return { ok: false, error: 'user 欄位格式錯誤' }; }
  if (!user.id) return { ok: false, error: 'user 缺少 id' };

  return {
    ok: true,
    userId: String(user.id),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') ||
                 (user.username ? '@' + user.username : ''),
  };
}

function bytesToHex_(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += ('0' + (bytes[i] & 0xFF).toString(16)).slice(-2);
  }
  return s;
}

// ─────────────────────────── 常駐鍵盤 ───────────────────────────

/**
 * 聊天室輸入框下方的四顆常駐按鈕。
 * 打卡與請假用 web_app 型別直接開迷你視窗(打卡需要在頁面內偵測 IP,
 * 純文字按鈕做不到);守則是純文字按鈕,由 bot 直接回覆。
 */
function tgPunchKeyboard_(companyCode) {
  const page = punchPageUrl_(companyCode);
  if (!page) return null;
  return {
    keyboard: [
      [{ text: '🟢 上班打卡', web_app: { url: page + '&type=in' } },
       { text: '🔴 下班打卡', web_app: { url: page + '&type=out' } }],
      [{ text: '📋 工作守則' },
       { text: '🗓 請假', web_app: { url: leavePageUrl_(companyCode) } }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function tgSendWithKeyboard_(botToken, chatId, html, keyboard) {
  const payload = {
    chat_id: String(chatId),
    text: String(html).slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = keyboard;
  return tgApi_(botToken, 'sendMessage', payload);
}

// ─────────────────────────── Webhook ───────────────────────────

function handleTelegramUpdate_(companyCode, update) {
  if (update.callback_query) return handleTgCallback_(companyCode, update.callback_query);

  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const from = msg.from || {};
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') ||
                      (from.username ? '@' + from.username : '');

  const bot = getBot_(companyCode);
  const t = tenant_(companyCode);

  // /start、/bind A001 之類的斜線指令轉成共用格式
  let text = String(msg.text).trim();
  const slash = text.match(/^\/([a-z_]+)(?:@\S+)?\s*(.*)$/i);
  if (slash) {
    const map = {
      start: '', help: '', bind: '綁定', punch: '打卡', today: '查詢',
      month: '本月', me: '我是誰', rules: '守則', leave: '請假', myleave: '我的請假',
    };
    const mapped = map[slash[1].toLowerCase()];
    text = mapped === undefined ? text : (mapped + (slash[2] ? ' ' + slash[2] : '')).trim();
  }

  const r = runCommand_(t, String(from.id || chatId), text, displayName);
  tgSendWithKeyboard_(bot.botToken, chatId, toHtml_(r.text),
                      r.showKeyboard ? tgPunchKeyboard_(companyCode) : null);
}

/** 審核按鈕:callback_data 格式 lv:ok|no:{公司代碼}:{申請編號} */
function handleTgCallback_(companyCode, cq) {
  const bot = getBot_(companyCode);
  const data = String(cq.data || '');
  const answer = (text, alert) => tgApi_(bot.botToken, 'answerCallbackQuery',
    { callback_query_id: cq.id, text: String(text).slice(0, 190), show_alert: !!alert });

  const parts = data.split(':');
  if (parts[0] !== 'lv' || parts.length < 4) return answer('無法辨識的操作');

  const decision = parts[1] === 'ok' ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.REJECTED;
  const targetCompany = parts[2];
  const leaveId = parts[3];

  // 按鈕是誰按的?必須是這家公司的管理員或平台管理員
  const userId = String((cq.from || {}).id || '');
  const admin = getAdmin_(userId);
  if (!admin || (admin.role !== ROLE.PLATFORM && admin.companyCode !== targetCompany)) {
    return answer('你沒有審核這家公司請假的權限', true);
  }

  let result;
  try {
    result = decideLeave_(tenant_(targetCompany), leaveId, decision, admin.name || '管理員', '');
  } catch (err) {
    logEvent_('ERROR', 'leave.callback', (err && err.stack) ? err.stack : err);
    return answer('處理失敗:' + err, true);
  }

  answer(result.message, !result.ok);

  // 把原訊息的按鈕換成結果,避免重複按
  if (result.ok && cq.message) {
    tgApi_(bot.botToken, 'editMessageText', {
      chat_id: String(cq.message.chat.id),
      message_id: cq.message.message_id,
      text: toHtml_(cq.message.text || '') +
            `\n\n<b>${decision === LEAVE_STATUS.APPROVED ? '✅ 已同意' : '❌ 已駁回'}</b>` +
            `(${escHtml_(admin.name || '管理員')})`,
      parse_mode: 'HTML',
    });
  }
}

/** 共用指令回覆是純文字,這裡只做最小轉義 */
function toHtml_(text) {
  return escHtml_(text);
}


// ╔═══ Commands.gs ═══

/**
 * Commands.gs — 聊天指令的共用邏輯
 *
 * LINE 與 Telegram 的訊息格式不同,但指令行為一模一樣,
 * 所以文字處理集中在這裡,兩邊的 webhook 只負責把回覆包成各自的格式。
 */

/**
 * @param {Object} t tenant
 * @param {string} userId 平台的使用者 ID
 * @param {string} text 已正規化的指令文字(空字串代表「剛加好友 / /start」)
 * @param {string} displayName
 * @return {{text:string, showKeyboard:boolean}}
 */
function runCommand_(t, userId, text, displayName) {
  const clean = String(text || '').trim().replace(/\s+/g, ' ');

  if (!clean) {
    return {
      text: `歡迎使用${t.name}打卡系統!\n\n` +
            '第一次使用請先綁定身分,直接輸入兩個字:\n\n綁定\n\n' +
            '送出後管理員會幫你設定資料,完成會通知你。',
      showKeyboard: false,
    };
  }

  // 「綁定」不帶編號 → 送出申請,等管理員設定
  if (/^(?:綁定|绑定|bind)$/i.test(clean)) {
    const r = tRegisterPending_(t, userId, displayName);
    notifyPendingEmployee_(t, userId, displayName, r.already);
    return { text: (r.already ? '' : '✅ ') + r.message, showKeyboard: false };
  }

  // 「綁定 A001」仍然支援,公司若已先發好編號可以直接用
  const bind = clean.match(/^(?:綁定|绑定|bind)\s*[:：]?\s*(\S+)$/i);
  if (bind) {
    const r = tBindEmployee_(t, bind[1], userId, displayName);
    if (!r.ok) return { text: '❌ ' + r.message, showKeyboard: false };
    return {
      text: '✅ ' + r.message + '\n\n下面的按鈕就是你平常會用到的功能。\n打卡記得要先連上公司 Wi-Fi。',
      showKeyboard: true,
    };
  }

  // 管理員用文字審核(LINE 沒有 inline 按鈕,Telegram 也可以這樣用)
  const decide = clean.match(/^(同意|核准|駁回|拒絕)\s*[:：]?\s*(\S+)$/);
  if (decide) {
    const admin = getAdmin_(userId);
    if (!admin || (admin.role !== ROLE.PLATFORM && admin.companyCode !== t.code)) {
      return { text: '你沒有審核請假的權限。', showKeyboard: false };
    }
    const approved = decide[1] === '同意' || decide[1] === '核准';
    const r = decideLeave_(t, decide[2],
      approved ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.REJECTED, admin.name || '管理員', '');
    return { text: (r.ok ? '✅ ' : '❌ ') + r.message, showKeyboard: false };
  }

  if (/^(守則|工作守則|規定|rules)$/i.test(clean)) {
    return { text: rulesText_(t), showKeyboard: true };
  }

  if (/^(請假|请假|leave)$/i.test(clean)) {
    const emp = tFindEmployeeByUserId_(t, userId);
    if (!emp) return { text: '你還沒有綁定,請先輸入「綁定」兩個字。', showKeyboard: false };
    return { text: leaveIntroText_(t), showKeyboard: true };
  }

  if (/^(我的請假|請假紀錄|myleave)$/i.test(clean)) {
    return { text: myLeavesText_(t, userId), showKeyboard: true };
  }

  if (/^(待審核|審核|pending)$/i.test(clean)) {
    const admin = getAdmin_(userId);
    if (!admin || (admin.role !== ROLE.PLATFORM && admin.companyCode !== t.code)) {
      return { text: '你沒有審核請假的權限。', showKeyboard: false };
    }
    return { text: pendingLeavesText_(t), showKeyboard: false };
  }

  if (/^(打卡|上班|下班|clock|punch)/i.test(clean)) {
    return { text: '請確認已連上公司 Wi-Fi,再用下面的按鈕打卡。', showKeyboard: true };
  }

  if (/^(查詢|今日|今天|today)$/i.test(clean)) {
    return { text: todaySummary_(t, userId), showKeyboard: true };
  }

  if (/^(本月|月報|month)$/i.test(clean)) {
    return { text: monthSummary_(t, userId), showKeyboard: true };
  }

  if (/^(我是誰|whoami|狀態|me)$/i.test(clean)) {
    const emp = tFindEmployeeByUserId_(t, userId);
    if (!emp) return { text: '你還沒有綁定,請輸入「綁定」兩個字。', showKeyboard: false };
    return {
      text: `公司:${t.name}\n員工編號:${emp['員工編號']}\n姓名:${emp['姓名']}\n` +
            `部門:${emp['部門'] || '—'}\n狀態:${emp['狀態'] || '在職'}`,
      showKeyboard: true,
    };
  }

  return {
    text: '可以用的指令:\n' +
          '• 打卡 — 開啟打卡頁\n' +
          '• 守則 — 查看工作守則\n' +
          '• 請假 — 請假說明與規則\n' +
          '• 我的請假 — 我的請假紀錄\n' +
          '• 查詢 — 今天的打卡紀錄\n' +
          '• 本月 — 本月出勤摘要\n' +
          '• 綁定 員工編號 — 綁定身分',
    showKeyboard: true,
  };
}

// ─────────────────────────── 請假 ───────────────────────────

function leaveIntroText_(t) {
  const types = tListLeaveTypes_(t);
  const lines = types.map(x => {
    const lead = x.leadDays > 0 ? `需提前 ${x.leadDays} 天` : '可事後補辦';
    const quota = x.quota ? ` · 上限 ${x.quota}` : '';
    return `• ${x.name} — ${lead}${quota} · 給薪 ${x.pay}`;
  });
  return `🗓 ${t.name} 請假說明\n\n` +
    '請用下面的「🗓 請假」按鈕開啟申請表。\n\n' +
    '假別與規則:\n' + lines.join('\n') +
    '\n\n送出後由主管審核,結果會用訊息通知你。';
}

function myLeavesText_(t, userId) {
  const emp = tFindEmployeeByUserId_(t, userId);
  if (!emp) return '你還沒有綁定,請先輸入「綁定」兩個字。';

  const list = tListLeaves_(t, { employeeCode: emp['員工編號'] }).slice(0, 10);
  if (!list.length) return `${emp['姓名']} 目前沒有請假紀錄。`;

  const icon = { '待審核': '⏳', '已核准': '✅', '已駁回': '❌', '已取消': '⚪' };
  return `${emp['姓名']} 的請假紀錄(最近 ${list.length} 筆)\n\n` +
    list.map(l => {
      const range = l.from === l.to ? l.from : `${l.from} ~ ${l.to}`;
      return `${icon[l.status] || ''} ${l.leaveType} ${range} (${l.days}天)\n` +
             `   ${l.status}${l.approver ? ' · ' + l.approver : ''} · ${l.id}`;
    }).join('\n');
}

function pendingLeavesText_(t) {
  const list = tListLeaves_(t, { status: LEAVE_STATUS.PENDING });
  if (!list.length) return `${t.name} 目前沒有待審核的請假申請。`;
  return `⏳ ${t.name} 待審核(${list.length} 筆)\n\n` +
    list.map(l => {
      const range = l.from === l.to ? l.from : `${l.from} ~ ${l.to}`;
      return `${l.id}  ${l.name}\n   ${l.leaveType} ${range} (${l.days}天)\n   事由:${l.reason}`;
    }).join('\n\n') +
    '\n\n回覆「同意 編號」或「駁回 編號」即可審核。';
}

// ─────────────────────────── 查詢 ───────────────────────────

function todaySummary_(t, userId) {
  const emp = tFindEmployeeByUserId_(t, userId);
  if (!emp) return '你還沒有綁定,請輸入「綁定」兩個字。';

  const now = new Date();
  const recs = tRecordsOfDay_(t, emp['員工編號'], now);
  const head = `${Utilities.formatDate(now, CONFIG.TZ, 'yyyy/MM/dd (E)')} ${emp['姓名']}`;
  if (recs.length === 0) return head + '\n\n今天還沒有打卡紀錄。';

  return head + '\n\n' + recs
    .map(r => `${fmtTime_(r['時間戳記'])}  ${r['類型']}  ${r['判定']}  @${r['地點']}`)
    .join('\n');
}

function monthSummary_(t, userId) {
  const emp = tFindEmployeeByUserId_(t, userId);
  if (!emp) return '你還沒有綁定,請輸入「綁定」兩個字。';

  const ym = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM');
  const code = String(emp['員工編號']).trim().toUpperCase();

  const rows = tRead_(t, SHEETS.RECORD).filter(r =>
    String(r['員工編號']).trim().toUpperCase() === code &&
    r['日期'] instanceof Date &&
    Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM') === ym);

  const byDay = {};
  rows.forEach(r => {
    const d = Utilities.formatDate(r['日期'], CONFIG.TZ, 'MM/dd');
    (byDay[d] = byDay[d] || []).push(r);
  });

  const days = Object.keys(byDay).sort();
  const late  = rows.filter(r => String(r['判定']).indexOf('遲到') === 0).length;
  const early = rows.filter(r => String(r['判定']).indexOf('早退') === 0).length;

  return `${ym} ${emp['姓名']} 出勤摘要\n\n` +
    `出勤天數:${days.length} 天\n遲到:${late} 次\n早退:${early} 次\n\n` +
    days.slice(-10).map(d => {
      const list = byDay[d];
      const i = list.filter(r => r['類型'] === PUNCH_IN)[0];
      const o = list.filter(r => r['類型'] === PUNCH_OUT).slice(-1)[0];
      return `${d}  ${i ? fmtTime_(i['時間戳記']) : '--:--'} → ${o ? fmtTime_(o['時間戳記']) : '--:--'}`;
    }).join('\n');
}

/** 有人送出綁定時通知管理員,附上他的 Telegram 暱稱好對人 */
function notifyPendingEmployee_(t, userId, displayName, already) {
  if (already) return;
  const text = `👤 <b>有新員工送出綁定</b>\n\n` +
    `${escHtml_(t.name)}\n` +
    `Telegram 暱稱:${escHtml_(displayName || '(沒有設定名稱)')}\n\n` +
    `請到後台「員工」分頁填上他的員工編號與姓名。`;
  approverUserIds_(t.code).forEach(uid => {
    try { botPushText_(t.code, uid, text); } catch (e) { /* 未與該 bot 互動過 */ }
  });
}


// ╔═══ Webhook.gs ═══

/**
 * Webhook.gs — LINE 官方帳號的訊息進入點
 *
 * Telegram 的進入點在 Telegram.gs 的 handleTelegramUpdate_()。
 * 兩邊的指令行為都走 Commands.gs 的 runCommand_(),只有回覆格式不同。
 */

function handleLineEvent_(companyCode, ev) {
  const t = tenant_(companyCode);
  const userId = ev.source && ev.source.userId;

  if (ev.type === 'follow') {
    const r = runCommand_(t, userId, '', '');
    return lineReply_(companyCode, ev.replyToken, textMsg_(r.text));
  }

  if (ev.type !== 'message' || ev.message.type !== 'text') return;

  const text = String(ev.message.text || '').trim();
  const displayName = /^(?:綁定|绑定|bind)/i.test(text)
    ? (lineProfile_(companyCode, userId).displayName || '')
    : '';

  const r = runCommand_(t, userId, text, displayName);
  const messages = [textMsg_(r.text)];
  if (r.showKeyboard) messages.push(punchButtonMsg_(companyCode, '打卡', '請確認已連上公司 Wi-Fi'));
  lineReply_(companyCode, ev.replyToken, messages);
}


// ╔═══ Auth.gs ═══

/**
 * Auth.gs — 後台登入與權限
 *
 * 管理員用 LINE 登入(和員工同一套身分系統),驗證通過後由後端簽發
 * 一組 HMAC 簽章的 session token,存在瀏覽器 localStorage,
 * 之後每次 API 呼叫都帶這組 token,不必反覆向 LINE 驗證。
 */

function b64_(s)   { return Utilities.base64EncodeWebSafe(s).replace(/=+$/, ''); }
function unb64_(s) { return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString(); }

function hmac_(data) {
  const sig = Utilities.computeHmacSha256Signature(data, CONFIG.sessionSecret);
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

/** 定時比較,避免以字串比較的時間差推敲簽章 */
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function signSession_(payload) {
  const body = b64_(JSON.stringify(payload));
  return body + '.' + hmac_(body);
}

/** @return {{ok:boolean, payload?:Object, error?:string}} */
function verifySession_(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, error: '登入資訊格式錯誤' };
  if (!safeEqual_(hmac_(parts[0]), parts[1])) return { ok: false, error: '登入資訊已失效' };

  let payload;
  try { payload = JSON.parse(unb64_(parts[0])); } catch (e) { return { ok: false, error: '登入資訊損毀' }; }
  if (!payload.exp || payload.exp < Date.now()) return { ok: false, error: '登入已逾時,請重新登入' };

  return { ok: true, payload: payload };
}

function issueSession_(admin) {
  return signSession_({
    uid:  admin.userId,
    role: admin.role,
    co:   admin.companyCode || '',
    name: admin.name || '',
    exp:  Date.now() + CONFIG.SESSION_HOURS * 3600000,
  });
}

// ─────────────────────────── 權限檢查 ───────────────────────────

/** 驗證 session 並回傳最新的管理員資料(會重讀主控表,停權後立即失效) */
function requireAdmin_(token) {
  const s = verifySession_(token);
  if (!s.ok) throw authError_(ERR.UNAUTHORIZED, s.error);
  const admin = getAdmin_(s.payload.uid);
  if (!admin) throw authError_(ERR.UNAUTHORIZED, '你的管理權限已被移除');
  return admin;
}

/** 平台管理員專用 */
function requirePlatform_(token) {
  const admin = requireAdmin_(token);
  if (admin.role !== ROLE.PLATFORM) throw authError_(ERR.FORBIDDEN, '這項操作只有平台管理員可以執行');
  return admin;
}

/** 驗證管理員對某公司有權限,回傳 {admin, tenant} */
function requireCompany_(token, companyCode) {
  const admin = requireAdmin_(token);
  const code = String(companyCode || '').trim().toUpperCase();
  if (!code) throw authError_(ERR.FORBIDDEN, '未指定公司');
  if (admin.role !== ROLE.PLATFORM && admin.companyCode !== code) {
    throw authError_(ERR.FORBIDDEN, '你沒有這家公司的權限');
  }
  return { admin: admin, t: tenant_(code) };
}

function authError_(code, message) {
  const e = new Error(message);
  e.appCode = code;
  return e;
}


// ╔═══ Admin.gs ═══

/**
 * Admin.gs — 管理後台 API
 *
 * 所有 action 都經過 Auth.gs 的權限檢查:
 *   平台管理員 → 可新增公司、看所有公司
 *   公司管理員 → 只能操作自己那一家
 */

const ADMIN_ACTIONS = {

  // ── 登入 ────────────────────────────────────────────────
  /** 首次啟用:用 SETUP_CODE 把自己登記為平台管理員 */
  'admin.bootstrap': function (b) {
    if (!CONFIG.setupCode) throw new Error('平台尚未初始化,請先執行 setupPlatform()');
    if (String(b.setupCode || '').trim().toUpperCase() !== CONFIG.setupCode.toUpperCase()) {
      throw new Error('啟用碼不正確');
    }
    const auth = verifyAdminIdentity_(b);
    if (!auth.ok) throw new Error('身分驗證失敗:' + auth.error);

    const admin = addAdmin_(auth.userId, auth.displayName, ROLE.PLATFORM, '');
    logEvent_('INFO', 'admin.bootstrap', '平台管理員 ' + auth.displayName);
    return { token: issueSession_(admin), me: publicAdmin_(admin) };
  },

  /** 一般登入;帶 inviteCode 則同時完成邀請 */
  'admin.login': function (b) {
    const auth = verifyAdminIdentity_(b);
    if (!auth.ok) throw new Error('身分驗證失敗:' + auth.error);

    if (b.inviteCode) {
      const r = useInvite_(b.inviteCode, auth.userId, auth.displayName);
      if (!r.ok) throw new Error(r.message);
    }

    const admin = getAdmin_(auth.userId);
    if (!admin) throw authError_(ERR.FORBIDDEN, '這個帳號還不是管理員。請向平台管理員索取邀請碼。');
    return { token: issueSession_(admin), me: publicAdmin_(admin) };
  },

  'admin.me': function (b) {
    return { me: publicAdmin_(requireAdmin_(b.token)) };
  },

  // ── 公司 ────────────────────────────────────────────────
  'company.list': function (b) {
    const admin = requireAdmin_(b.token);
    const all = listCompanies_();
    const visible = admin.role === ROLE.PLATFORM ? all : all.filter(c => c.code === admin.companyCode);
    return { companies: visible.map(c => ({
      code: c.code, name: c.name, status: c.status, note: c.note,
      platform: c.platform,
      platformLabel: PLATFORM_LABEL[c.platform] || c.platform,
      createdAt: c.createdAt instanceof Date ? Utilities.formatDate(c.createdAt, CONFIG.TZ, 'yyyy/MM/dd') : '',
      ready: botReady_(getBot_(c.code)),
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' + c.spreadsheetId,
    })) };
  },

  /**
   * 一次開好一家公司:建試算表、寫入 bot 憑證、允許網段、出勤時間、員工名冊,
   * 最後盡可能把平台端設定自動做完。
   */
  'company.provision': function (b) {
    requirePlatform_(b.token);

    const name = String(b.name || '').trim();
    if (!name) throw new Error('請輸入公司名稱');

    const platform = b.platform === PLATFORM.TELEGRAM ? PLATFORM.TELEGRAM : PLATFORM.LINE;

    // 先驗證憑證,免得公司都建好了才發現 token 是錯的
    let botLabel = '';
    let botUsername = '';
    if (platform === PLATFORM.TELEGRAM) {
      if (!String(b.botToken || '').trim()) throw new Error('請貼上 Telegram bot token');
      const me = tgGetMe_(String(b.botToken).trim());
      if (!me.ok) throw new Error(me.message);
      botLabel = '@' + me.username;
      botUsername = me.username;
    } else {
      if (!String(b.channelAccessToken || '').trim()) throw new Error('請貼上 LINE channel access token');
      if (!String(b.loginChannelId || '').trim())     throw new Error('請填入 LINE Login Channel ID');
      const chk = lineCheckToken_(String(b.channelAccessToken).trim());
      if (!chk.ok) throw new Error('Channel access token 驗證失敗:' + chk.message);
      botLabel = chk.displayName;
    }

    const ips = (b.ips || [])
      .map(x => (typeof x === 'string' ? { rule: x, location: name } : x))
      .filter(x => String(x.rule || '').trim())
      .map(x => ({ rule: String(x.rule).trim(), location: String(x.location || name).trim(), enabled: true, note: '建立公司時填入' }));
    if (!ips.length) throw new Error('請至少填一個允許的對外 IP,否則沒有人打得了卡');

    const co = createCompany_(b.code, name, platform, b.spreadsheetId);

    setBot_(co.code, {
      platform: platform,
      botToken: b.botToken,
      botUsername: botUsername,
      channelAccessToken: b.channelAccessToken,
      loginChannelId: b.loginChannelId,
      loginChannelSecret: b.loginChannelSecret,
      liffId: b.liffId,
    });

    const t = tenant_(co.code);
    tSaveIps_(t, ips);

    const settings = [];
    if (b.workStart) settings.push({ key: '上班時間', value: String(b.workStart).trim() });
    if (b.workEnd)   settings.push({ key: '下班時間', value: String(b.workEnd).trim() });
    if (settings.length) tSaveSettings_(t, settings);

    let imported = 0;
    if (String(b.employeesCsv || '').trim()) {
      imported = importEmployees_(t, b.employeesCsv).added;
    }

    const setup = botAutoSetup_(co.code, co.name);
    logEvent_('INFO', 'company.provision', `${co.code} / ${co.name} / ${platform} / ${botLabel}`);

    return {
      company: {
        code: co.code, name: co.name, platform: platform,
        platformLabel: PLATFORM_LABEL[platform],
        botLabel: botLabel,
        sheetUrl: t.ss.getUrl(),
        ipCount: ips.length,
        imported: imported,
      },
      urls: buildUrls_(co.code),
      done: setup.done,
      manual: setup.manual,
    };
  },

  'company.update': function (b) {
    requirePlatform_(b.token);
    const co = updateCompany_(b.code, { name: b.name, status: b.status, note: b.note });
    return { company: { code: co.code, name: co.name, status: co.status } };
  },

  /** 公司總覽:人數、今日打卡數、設定完成度 */
  'company.overview': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const t = ctx.t;
    const emps = tListEmployees_(t);
    const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM/dd');
    const todayRecs = tRead_(t, SHEETS.RECORD).filter(r =>
      r['日期'] instanceof Date && Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM/dd') === today);
    const bot = getBot_(t.code);

    return {
      name: t.name,
      platform: bot.platform,
      platformLabel: PLATFORM_LABEL[bot.platform],
      sheetUrl: t.ss.getUrl(),
      employees: emps.length,
      active: emps.filter(e => e.status === '在職').length,
      bound: emps.filter(e => e.bound).length,
      pendingEmployees: emps.filter(e => e.pending).length,
      todayIn:  todayRecs.filter(r => r['類型'] === PUNCH_IN).length,
      todayOut: todayRecs.filter(r => r['類型'] === PUNCH_OUT).length,
      ipRules: tListIps_(t).filter(r => r.enabled).length,
      pendingLeaves: tListLeaves_(t, { status: LEAVE_STATUS.PENDING }).length,
      ipEnforced: tSettingBool_(t, '啟用IP驗證', true),
      botReady: botReady_(bot),
      punchUrl: punchEntryUrl_(t.code),
    };
  },

  // ── Bot 設定 ────────────────────────────────────────────
  'bot.get': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const bot = getBot_(ctx.t.code);
    return {
      platform: bot.platform,
      platformLabel: PLATFORM_LABEL[bot.platform],
      loginChannelId: bot.loginChannelId,
      liffId: bot.liffId,
      botUsername: bot.botUsername,
      hasToken: bot.platform === PLATFORM.TELEGRAM ? !!bot.botToken : !!bot.channelAccessToken,
      hasSecret: !!bot.loginChannelSecret,
      urls: buildUrls_(ctx.t.code),
    };
  },

  'bot.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const code = ctx.t.code;
    const cur = getBot_(code);
    const platform = b.platform || cur.platform;
    let label = '';

    if (platform === PLATFORM.TELEGRAM) {
      const token = String(b.botToken || '').trim() || cur.botToken;
      if (!token) throw new Error('請貼上 Telegram bot token');
      const me = tgGetMe_(token);
      if (!me.ok) throw new Error(me.message);
      label = '@' + me.username;
      setBot_(code, { platform: platform, botToken: b.botToken, botUsername: me.username });
    } else {
      if (b.channelAccessToken) {
        const chk = lineCheckToken_(String(b.channelAccessToken).trim());
        if (!chk.ok) throw new Error('Channel access token 驗證失敗:' + chk.message);
        label = chk.displayName;
      }
      setBot_(code, {
        platform: platform,
        channelAccessToken: b.channelAccessToken,
        loginChannelId: b.loginChannelId,
        loginChannelSecret: b.loginChannelSecret,
        liffId: b.liffId,
      });
    }

    if (platform !== cur.platform) updateCompany_(code, { platform: platform });
    logEvent_('INFO', 'bot.save', `${code} / ${platform} by ${ctx.admin.name}`);
    return { ok: true, botLabel: label, urls: buildUrls_(code) };
  },

  /** 重跑自動設定(換了打卡頁網址、重新部署 Web App 之後用) */
  'bot.resync': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const bot = getBot_(ctx.t.code);
    const pageUrl = punchPageUrl_(ctx.t.code);

    // LINE 已經有 LIFF 的話改成更新它的 Endpoint URL
    if (bot.platform === PLATFORM.LINE && bot.liffId && bot.loginChannelSecret && pageUrl) {
      const r = lineUpdateLiff_(bot.loginChannelId, bot.loginChannelSecret, bot.liffId, pageUrl);
      const setup = botAutoSetup_(ctx.t.code, ctx.t.name);
      return {
        done: (r.ok ? ['已更新 LIFF 的 Endpoint URL'] : []).concat(setup.done),
        manual: (r.ok ? [] : ['更新 LIFF Endpoint 失敗:' + r.message]).concat(setup.manual),
        urls: buildUrls_(ctx.t.code),
      };
    }

    const setup = botAutoSetup_(ctx.t.code, ctx.t.name);
    return { done: setup.done, manual: setup.manual, urls: buildUrls_(ctx.t.code) };
  },

  // ── 平台設定 ────────────────────────────────────────────
  'platform.get': function (b) {
    requirePlatform_(b.token);
    const a = getAdminAuth_();
    return {
      pageBaseUrl: pageBaseUrl_(),
      webAppUrl: webAppUrl_(),
      adminPlatform: PROP.getProperty('ADMIN_PLATFORM') || '',
      adminPlatformEffective: a.platform,
      adminLoginChannelId: PROP.getProperty('ADMIN_LOGIN_CHANNEL_ID') || '',
      adminHasBotToken: !!PROP.getProperty('ADMIN_BOT_TOKEN'),
      trustProxy: CONFIG.trustProxy,
    };
  },

  'platform.save': function (b) {
    requirePlatform_(b.token);
    if (b.pageBaseUrl != null) PROP.setProperty('PAGE_BASE_URL', String(b.pageBaseUrl).trim().replace(/\/+$/, ''));
    if (b.adminPlatform != null) PROP.setProperty('ADMIN_PLATFORM', String(b.adminPlatform).trim());
    if (b.adminLoginChannelId != null) PROP.setProperty('ADMIN_LOGIN_CHANNEL_ID', String(b.adminLoginChannelId).trim());
    if (b.adminBotToken) {
      const me = tgGetMe_(String(b.adminBotToken).trim());
      if (!me.ok) throw new Error(me.message);
      PROP.setProperty('ADMIN_BOT_TOKEN', String(b.adminBotToken).trim());
    }
    return { ok: true };
  },

  // ── 管理員與邀請碼 ──────────────────────────────────────
  'admin.list': function (b) {
    const admin = requireAdmin_(b.token);
    const all = listAdmins_();
    const visible = admin.role === ROLE.PLATFORM ? all : all.filter(a => a.companyCode === admin.companyCode);
    return { admins: visible.map(publicAdmin_) };
  },

  'admin.remove': function (b) {
    const admin = requirePlatform_(b.token);
    if (b.userId === admin.userId) throw new Error('不能移除自己');
    const target = listAdmins_().find(a => a.userId === b.userId);
    if (!target) throw new Error('找不到這位管理員');
    mSheet_(M.ADMIN).getRange(target._row, M_HEADERS[M.ADMIN].indexOf('狀態') + 1).setValue('停用');
    SpreadsheetApp.flush();
    return { ok: true };
  },

  'invite.create': function (b) {
    const admin = requireAdmin_(b.token);
    const role = b.role === ROLE.PLATFORM ? ROLE.PLATFORM : ROLE.COMPANY;
    if (role === ROLE.PLATFORM) requirePlatform_(b.token);

    let companyCode = String(b.company || '').trim().toUpperCase();
    if (role === ROLE.COMPANY) {
      if (admin.role !== ROLE.PLATFORM) companyCode = admin.companyCode;
      if (!getCompany_(companyCode)) throw new Error('公司不存在:' + companyCode);
    } else {
      companyCode = '';
    }
    return { invite: createInvite_(role, companyCode, Number(b.days) || 7) };
  },

  'invite.list': function (b) {
    const admin = requireAdmin_(b.token);
    return { invites: listInvites_(admin.role === ROLE.PLATFORM ? (b.company || '') : admin.companyCode) };
  },

  // ── 設定 ────────────────────────────────────────────────
  'setting.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { settings: tRead_(ctx.t, SHEETS.SETTING)
      .filter(r => String(r['項目']).trim() !== '')
      .map(r => ({ key: String(r['項目']).trim(), value: r['值'], note: String(r['說明'] || '') })) };
  },

  'setting.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    tSaveSettings_(ctx.t, b.items || []);
    return { ok: true };
  },

  // ── 允許網段 ────────────────────────────────────────────
  'ip.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { rules: tListIps_(ctx.t) };
  },

  'ip.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const n = tSaveIps_(ctx.t, b.rules || []);
    logEvent_('INFO', 'ip.save', `${ctx.t.code} 共 ${n} 條 by ${ctx.admin.name}`);
    return { ok: true, count: n };
  },

  // ── 員工 ────────────────────────────────────────────────
  'emp.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { employees: tListEmployees_(ctx.t) };
  },

  'emp.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const e = b.employee || {};
    if (!String(e.code || '').trim()) throw new Error('請輸入員工編號');
    if (!String(e.name || '').trim()) throw new Error('請輸入姓名');
    tUpsertEmployee_(ctx.t, {
      code: String(e.code).trim(), name: String(e.name).trim(),
      dept: e.dept, status: e.status, note: e.note,
    });
    return { ok: true };
  },

  /** 設定「待設定」的員工是誰,並通知他可以開始打卡了 */
  'emp.assign': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const e = b.employee || {};
    const r = tAssignEmployee_(ctx.t, b.userId, e);

    try {
      botPushText_(ctx.t.code, b.userId,
        `✅ 你的資料設定完成了\n\n` +
        `公司:${ctx.t.name}\n姓名:${e.name}\n員工編號:${e.code}` +
        (e.dept ? `\n部門:${e.dept}` : '') +
        `\n\n現在可以開始打卡了。記得要先連上公司 Wi-Fi。`);
    } catch (err) { /* 未與 bot 互動過 */ }

    logEvent_('INFO', 'emp.assign', `${ctx.t.code} ${e.code} ${e.name} by ${ctx.admin.name}`);
    return { message: r.message };
  },

  /** 刪掉一筆還沒設定的綁定申請 */
  'emp.deletePending': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    tDeletePendingByUserId_(ctx.t, b.userId);
    logEvent_('INFO', 'emp.deletePending', `${ctx.t.code} ${b.userId} by ${ctx.admin.name}`);
    return { message: '已刪除這筆綁定申請' };
  },

  'emp.unbind': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    tUnbindEmployee_(ctx.t, b.employeeCode);
    logEvent_('INFO', 'emp.unbind', `${ctx.t.code} ${b.employeeCode} by ${ctx.admin.name}`);
    return { ok: true };
  },

  'emp.delete': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    tDeleteEmployee_(ctx.t, b.employeeCode);
    logEvent_('INFO', 'emp.delete', `${ctx.t.code} ${b.employeeCode} by ${ctx.admin.name}`);
    return { ok: true };
  },

  'emp.import': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return Object.assign({ ok: true }, importEmployees_(ctx.t, b.csv));
  },

  // ── 請假 ────────────────────────────────────────────────
  'leave.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return {
      leaves: tListLeaves_(ctx.t, { status: b.status || '', employeeCode: b.employeeCode || '' }).slice(0, 300),
      pending: tListLeaves_(ctx.t, { status: LEAVE_STATUS.PENDING }).length,
    };
  },

  'leave.decide': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const decision = b.approve ? LEAVE_STATUS.APPROVED : LEAVE_STATUS.REJECTED;
    const r = decideLeave_(ctx.t, b.leaveId, decision, ctx.admin.name || '管理員', b.note || '');
    if (!r.ok) throw new Error(r.message);
    return { message: r.message };
  },

  'leavetype.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { types: tListLeaveTypesAll_(ctx.t), defaultLead: tSettingNumber_(ctx.t, '預設提前天數', 3) };
  },

  'leavetype.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const n = tSaveLeaveTypes_(ctx.t, b.types || []);
    logEvent_('INFO', 'leavetype.save', `${ctx.t.code} 共 ${n} 種 by ${ctx.admin.name}`);
    return { count: n };
  },

  // ── 工作守則 ────────────────────────────────────────────
  'rules.list': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { rules: tListRules_(ctx.t) };
  },

  'rules.save': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const n = tSaveRules_(ctx.t, b.rules || []);
    logEvent_('INFO', 'rules.save', `${ctx.t.code} 共 ${n} 條 by ${ctx.admin.name}`);
    return { count: n };
  },

  // ── 紀錄與報表 ──────────────────────────────────────────
  'record.query': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    return { records: tQueryRecords_(ctx.t, b.from, b.to, b.employeeCode) };
  },

  /** 月度統計,後台「紀錄與報表」用 */
  'report.stats': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const ym = String(b.ym || Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM')).replace('-', '/');
    return { ym: ym, stats: tMonthlyStats_(ctx.t, ym) };
  },

  /** 立即產生月報並推播給管理員(不必等月底) */
  'report.send': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const ym = String(b.ym || Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM')).replace('-', '/');
    const r = sendMonthlyReport_(ctx.t.code, ym);
    return { message: r.message, url: r.url };
  },

  'report.build': function (b) {
    const ctx = requireCompany_(b.token, b.company);
    const ym = String(b.ym || Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM')).replace('-', '/');
    const r = tBuildMonthlyReport_(ctx.t, ym);
    return { ok: true, ym: ym, rows: r.rows, url: r.url };
  },
};

// ─────────────────────────── 共用 ───────────────────────────

/** CSV:員工編號,姓名,部門[,狀態] */
function importEmployees_(t, csv) {
  const rows = Utilities.parseCsv(String(csv || '').trim());
  let added = 0, skipped = 0;
  rows.forEach((r, i) => {
    const code = String(r[0] || '').trim();
    const name = String(r[1] || '').trim();
    if (!code || !name) { skipped++; return; }
    if (i === 0 && /員工編號|code/i.test(code)) { skipped++; return; }  // 略過標題列
    tUpsertEmployee_(t, {
      code: code, name: name,
      dept: String(r[2] || '').trim(),
      status: String(r[3] || '在職').trim() || '在職',
    });
    added++;
  });
  return { added: added, skipped: skipped };
}

function publicAdmin_(a) {
  return { userId: a.userId, name: a.name, role: a.role, companyCode: a.companyCode, status: a.status };
}

function webAppUrl_() {
  const saved = PROP.getProperty('WEB_APP_URL');
  if (saved) return saved;
  try {
    const url = ScriptApp.getService().getUrl();
    if (url) { PROP.setProperty('WEB_APP_URL', url); return url; }
  } catch (e) { /* 某些執行情境取不到 */ }
  return '';
}

/** 產生要貼到平台後台的網址 */
function buildUrls_(companyCode) {
  const bot = getBot_(companyCode);
  return {
    platform: bot.platform,
    webhook: webhookUrl_(companyCode) || '(尚未取得 Web App 網址)',
    page: punchPageUrl_(companyCode) || '(請先在平台設定填入打卡頁網址)',
    entry: punchEntryUrl_(companyCode) || '(尚未設定完成)',
  };
}

/** 後台 API 分派 */
function handleAdminAction_(body) {
  const fn = ADMIN_ACTIONS[body.action];
  if (!fn) return { ok: false, code: ERR.SERVER, message: '未知的操作:' + body.action };
  try {
    const data = fn(body) || {};
    data.ok = true;
    return data;
  } catch (err) {
    const code = err && err.appCode ? err.appCode : ERR.SERVER;
    if (code === ERR.SERVER) logEvent_('ERROR', body.action, err && err.stack ? err.stack : err);
    return { ok: false, code: code, message: String(err && err.message ? err.message : err) };
  }
}


// ╔═══ Leave.gs ═══

/**
 * Leave.gs — 請假申請與審核
 *
 * 流程:員工在 Telegram 點「請假」→ 開啟申請表 → 送出 → 狀態「待審核」
 *       → 推播給該公司所有管理員,附「同意 / 駁回」按鈕
 *       → 管理員按下後回寫狀態,並通知申請人
 *
 * 提前天數:可預期的假別(事假、特休、婚假…)預設要提前 3 天;
 * 突發性假別(病假、喪假、公傷)在「假別」分頁設為 0,不能擋。
 * 詳見 docs/台灣勞工制度.md。
 */

// ─────────────────────────── 假別 ───────────────────────────

function tListLeaveTypes_(t) {
  return tRead_(t, SHEETS.LEAVETYPE)
    .filter(r => String(r['假別']).trim() !== '')
    .filter(r => String(r['啟用']).trim().toUpperCase() === 'TRUE')
    .map(r => ({
      name:      String(r['假別']).trim(),
      leadDays:  r['需提前天數'] === '' || r['需提前天數'] == null
                   ? tSettingNumber_(t, '預設提前天數', 3)
                   : Number(r['需提前天數']) || 0,
      quota:     String(r['年度上限'] || ''),
      pay:       String(r['給薪比例'] || ''),
      proof:     String(r['需附證明'] || '否'),
      note:      String(r['法源與說明'] || ''),
    }));
}

function tFindLeaveType_(t, name) {
  const target = String(name || '').trim();
  return tListLeaveTypes_(t).find(x => x.name === target) || null;
}

/** 後台用:含停用的完整清單 */
function tListLeaveTypesAll_(t) {
  return tRead_(t, SHEETS.LEAVETYPE)
    .filter(r => String(r['假別']).trim() !== '')
    .map(r => ({
      name: String(r['假別']).trim(),
      leadDays: r['需提前天數'] === '' || r['需提前天數'] == null ? '' : Number(r['需提前天數']),
      quota: String(r['年度上限'] || ''),
      pay: String(r['給薪比例'] || ''),
      proof: String(r['需附證明'] || ''),
      enabled: String(r['啟用']).trim().toUpperCase() === 'TRUE',
      note: String(r['法源與說明'] || ''),
    }));
}

function tSaveLeaveTypes_(t, rows) {
  const sh = tSheet_(t, SHEETS.LEAVETYPE);
  const last = sh.getLastRow();
  const width = HEADERS[SHEETS.LEAVETYPE].length;
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  const clean = (rows || [])
    .filter(r => String(r.name || '').trim() !== '')
    .map(r => [String(r.name).trim(), r.leadDays === '' ? '' : Number(r.leadDays) || 0,
               String(r.quota || ''), String(r.pay || ''), String(r.proof || '否'),
               r.enabled ? 'TRUE' : 'FALSE', String(r.note || '')]);
  if (clean.length) sh.getRange(2, 1, clean.length, width).setValues(clean);
  SpreadsheetApp.flush();
  return clean.length;
}

// ─────────────────────────── 工作守則 ───────────────────────────

function tListRules_(t) {
  return tRead_(t, SHEETS.RULES)
    .filter(r => String(r['標題']).trim() !== '')
    .map(r => ({
      order: Number(r['排序']) || 0,
      title: String(r['標題']).trim(),
      body: String(r['內容'] || ''),
      enabled: String(r['啟用']).trim().toUpperCase() === 'TRUE',
    }))
    .sort((a, b) => a.order - b.order);
}

function tSaveRules_(t, rows) {
  const sh = tSheet_(t, SHEETS.RULES);
  const last = sh.getLastRow();
  const width = HEADERS[SHEETS.RULES].length;
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  const clean = (rows || [])
    .filter(r => String(r.title || '').trim() !== '')
    .map((r, i) => [Number(r.order) || (i + 1), String(r.title).trim(),
                    String(r.body || ''), r.enabled ? 'TRUE' : 'FALSE']);
  if (clean.length) sh.getRange(2, 1, clean.length, width).setValues(clean);
  SpreadsheetApp.flush();
  return clean.length;
}

/** 給聊天室用的純文字版守則 */
function rulesText_(t) {
  const list = tListRules_(t).filter(r => r.enabled);
  if (!list.length) return `${t.name} 尚未設定工作守則。`;
  return `📋 ${t.name} 工作守則\n\n` +
    list.map(r => `【${r.title}】\n${r.body}`).join('\n\n');
}

// ─────────────────────────── 日期工具 ───────────────────────────

function todayStart_() {
  return new Date(Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM/dd'));
}

function parseDate_(s) {
  const m = String(s || '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate_(d) {
  return d instanceof Date ? Utilities.formatDate(d, CONFIG.TZ, 'yyyy/MM/dd') : String(d || '');
}

function daysBetween_(a, b) {
  return Math.round((b - a) / 86400000);
}

/**
 * 計算請假天數。半天以 0.5 計。
 * 只算日曆天,不扣除例假日 —— 各公司排班不同,由管理員審核時判斷。
 */
function countLeaveDays_(from, fromHalf, to, toHalf) {
  let days = daysBetween_(from, to) + 1;
  if (days <= 0) return 0;
  if (days === 1) return (fromHalf === '全天' && toHalf === '全天') ? 1 : 0.5;
  if (fromHalf === '下午') days -= 0.5;
  if (toHalf === '上午')   days -= 0.5;
  return days;
}

// ─────────────────────────── 申請 ───────────────────────────

function nextLeaveId_(t) {
  const rows = tRead_(t, SHEETS.LEAVE);
  const ym = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMM');
  const prefix = 'L' + ym;
  let max = 0;
  rows.forEach(r => {
    const id = String(r['申請編號'] || '');
    if (id.indexOf(prefix) === 0) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  });
  return prefix + ('00' + (max + 1)).slice(-3);
}

/**
 * 送出請假申請。
 * @return {{ok:boolean, code?:string, message:string, leave?:Object}}
 */
function submitLeave_(t, emp, payload) {
  const type = tFindLeaveType_(t, payload.leaveType);
  if (!type) return { ok: false, message: '假別不存在或已停用:' + payload.leaveType };

  const from = parseDate_(payload.from);
  const to   = parseDate_(payload.to || payload.from);
  if (!from || !to) return { ok: false, message: '日期格式錯誤,請用 yyyy/MM/dd' };
  if (to < from)    return { ok: false, message: '結束日期不能早於開始日期' };

  const fromHalf = ['全天', '上午', '下午'].indexOf(payload.fromHalf) >= 0 ? payload.fromHalf : '全天';
  const toHalf   = ['全天', '上午', '下午'].indexOf(payload.toHalf)   >= 0 ? payload.toHalf   : '全天';

  const days = countLeaveDays_(from, fromHalf, to, toHalf);
  if (days <= 0) return { ok: false, message: '請假時段不正確' };

  const reason = String(payload.reason || '').trim();
  if (!reason) return { ok: false, message: '請填寫請假事由' };

  // 提前天數檢查
  const lead = daysBetween_(todayStart_(), from);
  if (type.leadDays > 0 && lead < type.leadDays) {
    return {
      ok: false, code: 'LEAD_TIME',
      message: `${type.name}需於開始日 ${type.leadDays} 天前提出申請。\n` +
               `你選的開始日是 ${fmtDate_(from)},只提前 ${lead} 天。\n\n` +
               `如果是臨時狀況,請直接聯絡主管處理。`,
    };
  }

  // 重疊檢查
  const overlap = tListLeaves_(t, { employeeCode: emp['員工編號'] }).find(l =>
    (l.status === LEAVE_STATUS.PENDING || l.status === LEAVE_STATUS.APPROVED) &&
    !(parseDate_(l.to) < from || parseDate_(l.from) > to));
  if (overlap) {
    return { ok: false, message: `這段期間已經有一筆${overlap.status}的${overlap.leaveType}(${overlap.from} ~ ${overlap.to}),請先取消或改期。` };
  }

  const needApproval = tSettingBool_(t, '請假需審核', true);
  const id = nextLeaveId_(t);
  const now = new Date();

  tSheet_(t, SHEETS.LEAVE).appendRow([
    id, now,
    String(emp['員工編號']), String(emp['姓名']), String(emp['部門'] || ''),
    type.name,
    from, fromHalf, to, toHalf, days, reason,
    needApproval ? LEAVE_STATUS.PENDING : LEAVE_STATUS.APPROVED,
    needApproval ? '' : '(免審核)', needApproval ? '' : now, '',
  ]);
  SpreadsheetApp.flush();

  const leave = {
    id: id, employeeCode: String(emp['員工編號']), name: String(emp['姓名']),
    dept: String(emp['部門'] || ''), leaveType: type.name,
    from: fmtDate_(from), fromHalf: fromHalf, to: fmtDate_(to), toHalf: toHalf,
    days: days, reason: reason,
    status: needApproval ? LEAVE_STATUS.PENDING : LEAVE_STATUS.APPROVED,
  };

  if (needApproval) notifyApprovers_(t, leave);
  logEvent_('INFO', 'leave.submit', `${t.code} ${id} ${leave.name} ${type.name} ${leave.from}~${leave.to}`);

  return {
    ok: true, leave: leave,
    message: needApproval
      ? `已送出申請 ${id},等待主管審核。核准或駁回都會用訊息通知你。`
      : `已完成請假登記 ${id}(本公司設定為免審核)。`,
  };
}

// ─────────────────────────── 查詢 ───────────────────────────

function rowToLeave_(r) {
  return {
    id:           String(r['申請編號'] || ''),
    appliedAt:    r['申請時間'] instanceof Date ? Utilities.formatDate(r['申請時間'], CONFIG.TZ, 'yyyy/MM/dd HH:mm') : '',
    employeeCode: String(r['員工編號'] || ''),
    name:         String(r['姓名'] || ''),
    dept:         String(r['部門'] || ''),
    leaveType:    String(r['假別'] || ''),
    from:         fmtDate_(r['開始日期']),
    fromHalf:     String(r['開始時段'] || '全天'),
    to:           fmtDate_(r['結束日期']),
    toHalf:       String(r['結束時段'] || '全天'),
    days:         Number(r['天數']) || 0,
    reason:       String(r['事由'] || ''),
    status:       String(r['狀態'] || LEAVE_STATUS.PENDING),
    approver:     String(r['審核人'] || ''),
    approvedAt:   r['審核時間'] instanceof Date ? Utilities.formatDate(r['審核時間'], CONFIG.TZ, 'yyyy/MM/dd HH:mm') : '',
    approveNote:  String(r['審核備註'] || ''),
    _row:         r._row,
  };
}

function tListLeaves_(t, filter) {
  const f = filter || {};
  return tRead_(t, SHEETS.LEAVE)
    .filter(r => String(r['申請編號']).trim() !== '')
    .map(rowToLeave_)
    .filter(l => !f.employeeCode || l.employeeCode.toUpperCase() === String(f.employeeCode).toUpperCase())
    .filter(l => !f.status || l.status === f.status)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : -1));
}

function tGetLeave_(t, id) {
  const target = String(id || '').trim().toUpperCase();
  return tListLeaves_(t).find(l => l.id.toUpperCase() === target) || null;
}

// ─────────────────────────── 審核 ───────────────────────────

/**
 * 核准或駁回。
 * @param {string} decision LEAVE_STATUS.APPROVED 或 LEAVE_STATUS.REJECTED
 * @return {{ok:boolean, message:string, leave?:Object}}
 */
function decideLeave_(t, id, decision, approverName, note) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const leave = tGetLeave_(t, id);
    if (!leave) return { ok: false, message: '找不到申請編號:' + id };
    if (leave.status !== LEAVE_STATUS.PENDING) {
      return { ok: false, message: `這筆申請已經是「${leave.status}」,由 ${leave.approver || '系統'} 處理過了。` };
    }

    const sh = tSheet_(t, SHEETS.LEAVE);
    const head = HEADERS[SHEETS.LEAVE];
    sh.getRange(leave._row, head.indexOf('狀態') + 1).setValue(decision);
    sh.getRange(leave._row, head.indexOf('審核人') + 1).setValue(approverName || '');
    sh.getRange(leave._row, head.indexOf('審核時間') + 1).setValue(new Date());
    if (note) sh.getRange(leave._row, head.indexOf('審核備註') + 1).setValue(note);
    SpreadsheetApp.flush();

    leave.status = decision;
    leave.approver = approverName || '';
    notifyApplicant_(t, leave, note);
    logEvent_('INFO', 'leave.decide', `${t.code} ${id} → ${decision} by ${approverName}`);

    return { ok: true, message: `${leave.name} 的${leave.leaveType}已${decision}`, leave: leave };
  } finally {
    lock.releaseLock();
  }
}

/** 員工自行取消尚未審核的申請 */
function cancelLeave_(t, id, employeeCode) {
  const leave = tGetLeave_(t, id);
  if (!leave) return { ok: false, message: '找不到申請編號:' + id };
  if (employeeCode && leave.employeeCode.toUpperCase() !== String(employeeCode).toUpperCase()) {
    return { ok: false, message: '只能取消自己的申請' };
  }
  if (leave.status !== LEAVE_STATUS.PENDING) {
    return { ok: false, message: `這筆申請已經是「${leave.status}」,無法取消。` };
  }
  const sh = tSheet_(t, SHEETS.LEAVE);
  sh.getRange(leave._row, HEADERS[SHEETS.LEAVE].indexOf('狀態') + 1).setValue(LEAVE_STATUS.CANCELLED);
  SpreadsheetApp.flush();
  return { ok: true, message: `已取消申請 ${id}` };
}

// ─────────────────────────── 通知 ───────────────────────────

function leaveSummaryText_(l) {
  const range = l.from === l.to
    ? `${l.from}${l.fromHalf === '全天' ? '' : ' ' + l.fromHalf}`
    : `${l.from}${l.fromHalf === '全天' ? '' : '(' + l.fromHalf + ')'} ~ ${l.to}${l.toHalf === '全天' ? '' : '(' + l.toHalf + ')'}`;
  return `假別:${l.leaveType}\n日期:${range}\n天數:${l.days} 天\n事由:${l.reason}`;
}

/** 這家公司該通知誰審核:該公司的管理員 + 平台管理員 */
function approverUserIds_(companyCode) {
  return listAdmins_()
    .filter(a => a.status === '啟用')
    .filter(a => a.role === ROLE.PLATFORM || a.companyCode === String(companyCode).toUpperCase())
    .map(a => a.userId)
    .filter(Boolean);
}

function notifyApprovers_(t, leave) {
  const bot = getBot_(t.code);
  const ids = approverUserIds_(t.code);
  if (!ids.length) {
    logEvent_('WARN', 'leave.notify', t.code + ' 沒有可通知的管理員');
    return;
  }
  const text = `🗓 <b>新的請假申請</b>\n\n` +
    `申請人:${escHtml_(leave.name)}(${escHtml_(leave.employeeCode)})` +
    (leave.dept ? ` · ${escHtml_(leave.dept)}` : '') + '\n' +
    escHtml_(leaveSummaryText_(leave)) + `\n\n編號:<code>${escHtml_(leave.id)}</code>`;

  ids.forEach(uid => {
    try {
      if (bot.platform === PLATFORM.TELEGRAM) {
        tgApi_(bot.botToken, 'sendMessage', {
          chat_id: String(uid), text: text, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ 同意', callback_data: `lv:ok:${t.code}:${leave.id}` },
            { text: '❌ 駁回', callback_data: `lv:no:${t.code}:${leave.id}` },
          ]] },
        });
      } else {
        linePush_(t.code, uid, textMsg_(
          `🗓 新的請假申請\n\n申請人:${leave.name}(${leave.employeeCode})\n` +
          leaveSummaryText_(leave) + `\n\n編號:${leave.id}\n\n` +
          `請回覆「同意 ${leave.id}」或「駁回 ${leave.id}」`));
      }
    } catch (e) {
      logEvent_('WARN', 'leave.notify', `${t.code} 通知 ${uid} 失敗:${e}`);
    }
  });
}

function notifyApplicant_(t, leave, note) {
  const emp = tFindEmployeeByCode_(t, leave.employeeCode);
  const uid = emp ? String(emp['平台UserID']).trim() : '';
  if (!uid) return;

  const ok = leave.status === LEAVE_STATUS.APPROVED;
  const text = `${ok ? '✅' : '❌'} 你的請假申請已${leave.status}\n\n` +
    leaveSummaryText_(leave) +
    `\n\n編號:${leave.id}` +
    (leave.approver ? `\n審核人:${leave.approver}` : '') +
    (note ? `\n備註:${note}` : '');

  try { botPushText_(t.code, uid, escHtml_(text)); } catch (e) { /* 未加好友 */ }
}

function escHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


// ╔═══ Punch.gs ═══

/**
 * Punch.gs — 打卡核心邏輯
 *
 * 每個請求都必須帶 company(公司代碼),身分驗證會用該公司自己的 bot 憑證,
 * 確保 A 公司的憑證不能拿來打 B 公司的卡。LINE 與 Telegram 的差異
 * 都封裝在 Bot.gs,這裡不需要知道。
 */

/**
 * 打卡頁最先呼叫:用公司代碼換取該公司要用哪一個平台、哪一組 LIFF。
 * 這樣一份靜態頁就能服務所有公司。只回傳公開資訊,不需要身分驗證。
 */
function handleConfig(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤,請聯絡管理員確認打卡連結。' };
  if (co.status !== '啟用') return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」目前為停用狀態。` };

  const bot = getBot_(co.code);
  if (!botReady_(bot)) {
    return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」的${PLATFORM_LABEL[bot.platform]}設定尚未完成,請聯絡管理員。` };
  }

  return { ok: true, companyName: co.name, platform: bot.platform, liffId: bot.liffId };
}

/** 打卡頁載入時呼叫 */
function handleStatus(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤,請聯絡管理員確認打卡連結。' };
  if (co.status !== '啟用') return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」目前為停用狀態。` };

  const auth = botVerifyUser_(co.code, payload);
  if (!auth.ok) return { ok: false, code: ERR.BAD_TOKEN, message: '身分驗證失敗:' + auth.error };

  const t = tenant_(co.code);
  const emp = tFindEmployeeByUserId_(t, auth.userId);
  if (!emp) {
    return {
      ok: false, code: ERR.NOT_BOUND, companyName: co.name, displayName: auth.displayName,
      message: '你的帳號還沒有綁定。請回聊天室輸入「綁定」兩個字。',
    };
  }

  const now = new Date();
  const records = tRecordsOfDay_(t, emp['員工編號'], now);
  const punchIn  = records.filter(r => r['類型'] === PUNCH_IN)[0] || null;
  const punchOut = records.filter(r => r['類型'] === PUNCH_OUT).slice(-1)[0] || null;
  const ipCheck = tCheckIps_(t, payload.ips);

  return {
    ok: true,
    companyName: co.name,
    ipCheck: { allowed: ipCheck.allowed, ip: ipCheck.ip, location: ipCheck.location,
               enforced: ipCheck.enforced, reason: ipCheck.reason,
               title: ipCheck.allowed ? '' : ipDeniedTitle_(ipCheck),
               hint:  ipCheck.allowed ? '' : ipDeniedMessage_(ipCheck) },
    code: String(emp['員工編號']),
    name: String(emp['姓名']),
    dept: String(emp['部門'] || ''),
    dateText: Utilities.formatDate(now, CONFIG.TZ, 'yyyy/MM/dd (E)'),
    workStart: fmtHHmm_(t, '上班時間', 9, 0),
    workEnd:   fmtHHmm_(t, '下班時間', 18, 0),
    suggest: punchIn ? PUNCH_OUT : PUNCH_IN,
    today: {
      in:  punchIn  ? fmtTime_(punchIn['時間戳記'])  : null,
      out: punchOut ? fmtTime_(punchOut['時間戳記']) : null,
      inJudgement:  punchIn  ? String(punchIn['判定'])  : null,
      outJudgement: punchOut ? String(punchOut['判定']) : null,
    },
  };
}

/** 執行打卡 */
function handlePunch(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤,請聯絡管理員確認打卡連結。' };
  if (co.status !== '啟用') return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」目前為停用狀態。` };

  const auth = botVerifyUser_(co.code, payload);
  if (!auth.ok) return { ok: false, code: ERR.BAD_TOKEN, message: '身分驗證失敗:' + auth.error };

  const t = tenant_(co.code);
  const emp = tFindEmployeeByUserId_(t, auth.userId);
  if (!emp) return { ok: false, code: ERR.NOT_BOUND, message: '你的帳號還沒有綁定。請回聊天室輸入「綁定」兩個字。' };

  const status = String(emp['狀態']).trim();
  if (status === EMP_STATUS.PENDING) {
    return { ok: false, code: ERR.INACTIVE,
             message: '你的綁定還在等管理員設定資料,設定完成後才能打卡。\n設定好會用訊息通知你。' };
  }
  if (status && status !== EMP_STATUS.ACTIVE) {
    return { ok: false, code: ERR.INACTIVE, message: `你的狀態為「${status}」,無法打卡,請聯絡管理員。` };
  }

  const ipCheck = tCheckIps_(t, payload.ips);
  if (!ipCheck.allowed) {
    logEvent_('INFO', 'punch', `${co.code} IP 拒絕 ${emp['員工編號']} ${type_(payload)} ${ipCheck.ip} (${ipCheck.reason})`);
    return {
      ok: false, code: ERR.IP_DENIED, ip: ipCheck.ip, reason: ipCheck.reason,
      title: ipDeniedTitle_(ipCheck),
      message: ipDeniedMessage_(ipCheck),
    };
  }

  const type = payload.type === PUNCH_OUT ? PUNCH_OUT : PUNCH_IN;
  const now = new Date();

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const gapMin = tSettingNumber_(t, '重複打卡間隔', 3);
    const last = tRecordsOfDay_(t, emp['員工編號'], now).filter(r => r['類型'] === type).slice(-1)[0];
    if (last && (now - new Date(last['時間戳記'])) < gapMin * 60000) {
      return {
        ok: false, code: ERR.DUPLICATE,
        message: `你在 ${fmtTime_(last['時間戳記'])} 已經完成${type}打卡了,${gapMin} 分鐘內不需要重複打卡。`,
      };
    }

    const judgement = judge_(t, type, now);
    tAppendRecord_(t, {
      timestamp: now,
      date: new Date(Utilities.formatDate(now, CONFIG.TZ, 'yyyy/MM/dd')),
      time: Utilities.formatDate(now, CONFIG.TZ, 'HH:mm:ss'),
      code: String(emp['員工編號']),
      name: String(emp['姓名']),
      dept: String(emp['部門'] || ''),
      type: type,
      judgement: judgement,
      location: ipCheck.location,
      ip: ipCheck.ip,
      ipVerified: ipCheck.trustLabel,
      ua: shortUa_(payload.ua),
      note: String(payload.note || '').slice(0, 200),
    });
    SpreadsheetApp.flush();

    const result = {
      ok: true,
      type: type,
      time: Utilities.formatDate(now, CONFIG.TZ, 'HH:mm'),
      dateText: Utilities.formatDate(now, CONFIG.TZ, 'yyyy/MM/dd (E)'),
      code: String(emp['員工編號']),
      name: String(emp['姓名']),
      location: ipCheck.location,
      judgement: judgement,
      companyName: co.name,
    };

    try { botPushPunchResult_(co.code, auth.userId, result); } catch (e) { /* 未加好友時會失敗 */ }
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** 遲到 / 早退判定 */
function judge_(t, type, now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  if (type === PUNCH_IN) {
    const s = parseHHmm_(tSetting_(t, '上班時間', '09:00'), 9, 0);
    const base = s.h * 60 + s.m;
    return mins > base + tSettingNumber_(t, '遲到寬限分鐘', 10) ? `遲到 ${mins - base} 分` : '正常';
  }
  const e = parseHHmm_(tSetting_(t, '下班時間', '18:00'), 18, 0);
  const base = e.h * 60 + e.m;
  return mins < base - tSettingNumber_(t, '早退寬限分鐘', 10) ? `早退 ${base - mins} 分` : '正常';
}

function type_(payload) {
  return payload && payload.type === PUNCH_OUT ? PUNCH_OUT : PUNCH_IN;
}

function shortUa_(ua) {
  const s = String(ua || '');
  const os = /iPhone|iPad/i.test(s) ? 'iOS' : /Android/i.test(s) ? 'Android' : '其他';
  const app = /Line/i.test(s) ? ' / LINE' : /Telegram/i.test(s) ? ' / Telegram' : '';
  return os + app;
}

// ─────────────────────────── 請假(給 leave.html 用)───────────────────────────

/** 開啟請假頁時載入:員工資料 + 可選假別 + 自己的紀錄 */
function handleLeaveInfo(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤,請聯絡管理員確認連結。' };
  if (co.status !== '啟用') return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」目前為停用狀態。` };

  const auth = botVerifyUser_(co.code, payload);
  if (!auth.ok) return { ok: false, code: ERR.BAD_TOKEN, message: '身分驗證失敗:' + auth.error };

  const t = tenant_(co.code);
  const emp = tFindEmployeeByUserId_(t, auth.userId);
  if (!emp) {
    return { ok: false, code: ERR.NOT_BOUND, companyName: co.name,
             message: '你的帳號還沒有綁定,請先在聊天室輸入「綁定」兩個字。' };
  }

  return {
    ok: true,
    companyName: co.name,
    code: String(emp['員工編號']),
    name: String(emp['姓名']),
    dept: String(emp['部門'] || ''),
    today: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
    needApproval: tSettingBool_(t, '請假需審核', true),
    leaveTypes: tListLeaveTypes_(t),
    myLeaves: tListLeaves_(t, { employeeCode: emp['員工編號'] }).slice(0, 20),
  };
}

/** 送出請假申請 */
function handleLeaveSubmit(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤。' };
  if (co.status !== '啟用') return { ok: false, code: ERR.NO_COMPANY, message: `「${co.name}」目前為停用狀態。` };

  const auth = botVerifyUser_(co.code, payload);
  if (!auth.ok) return { ok: false, code: ERR.BAD_TOKEN, message: '身分驗證失敗:' + auth.error };

  const t = tenant_(co.code);
  const emp = tFindEmployeeByUserId_(t, auth.userId);
  if (!emp) return { ok: false, code: ERR.NOT_BOUND, message: '你的帳號還沒有綁定。請回聊天室輸入「綁定」兩個字。' };

  const status = String(emp['狀態']).trim();
  if (status === EMP_STATUS.PENDING) {
    return { ok: false, code: ERR.INACTIVE, message: '你的綁定還在等管理員設定資料,設定完成後才能請假。' };
  }
  if (status && status !== EMP_STATUS.ACTIVE) {
    return { ok: false, code: ERR.INACTIVE, message: `你的狀態為「${status}」,無法請假。` };
  }

  return submitLeave_(t, emp, payload);
}

/** 員工取消自己尚未審核的申請 */
function handleLeaveCancel(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤。' };

  const auth = botVerifyUser_(co.code, payload);
  if (!auth.ok) return { ok: false, code: ERR.BAD_TOKEN, message: '身分驗證失敗:' + auth.error };

  const t = tenant_(co.code);
  const emp = tFindEmployeeByUserId_(t, auth.userId);
  if (!emp) return { ok: false, code: ERR.NOT_BOUND, message: '你的帳號還沒有綁定。請回聊天室輸入「綁定」兩個字。' };

  return cancelLeave_(t, payload.leaveId, emp['員工編號']);
}

/** 工作守則(給頁面顯示用) */
function handleRules(payload) {
  const co = getCompany_(payload.company);
  if (!co) return { ok: false, code: ERR.NO_COMPANY, message: '公司代碼錯誤。' };
  const t = tenant_(co.code);
  return { ok: true, companyName: co.name, rules: tListRules_(t).filter(r => r.enabled) };
}


// ╔═══ Report.gs ═══

/**
 * Report.gs — 月報表
 *
 * 每位員工每天一列:上班 / 下班 / 工時 / 判定。
 * 由後台的「紀錄」分頁按「產生月報」呼叫,結果寫進該公司試算表的「月報」分頁。
 */

/**
 * @param {Object} t tenant
 * @param {string} ym 格式 'yyyy/MM'
 * @return {{rows:number, url:string}}
 */
function tBuildMonthlyReport_(t, ym) {
  const rows = tRead_(t, SHEETS.RECORD).filter(r =>
    r['日期'] instanceof Date &&
    Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM') === ym);

  const groups = {};
  rows.forEach(r => {
    const day = Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM/dd');
    const key = String(r['員工編號']).trim().toUpperCase() + '|' + day;
    (groups[key] = groups[key] || { day: day, rows: [] }).rows.push(r);
  });

  const out = [];
  Object.keys(groups).sort().forEach(key => {
    const g = groups[key];
    const list = g.rows.sort((a, b) => new Date(a['時間戳記']) - new Date(b['時間戳記']));
    const first = list[0];
    const inRec  = list.filter(r => r['類型'] === PUNCH_IN)[0] || null;
    const outRec = list.filter(r => r['類型'] === PUNCH_OUT).slice(-1)[0] || null;

    let hours = '';
    if (inRec && outRec) {
      const ms = new Date(outRec['時間戳記']) - new Date(inRec['時間戳記']);
      if (ms > 0) hours = Math.round((ms / 3600000) * 100) / 100;
    }

    const flags = [];
    if (!inRec)  flags.push('缺上班卡');
    if (!outRec) flags.push('缺下班卡');
    if (inRec  && String(inRec['判定']).indexOf('遲到')  === 0) flags.push(String(inRec['判定']));
    if (outRec && String(outRec['判定']).indexOf('早退') === 0) flags.push(String(outRec['判定']));

    out.push([
      g.day,
      String(first['員工編號']),
      String(first['姓名']),
      String(first['部門'] || ''),
      inRec  ? fmtTime_(inRec['時間戳記'])  : '',
      outRec ? fmtTime_(outRec['時間戳記']) : '',
      hours,
      flags.length ? flags.join('、') : '正常',
      inRec ? String(inRec['地點']) : (outRec ? String(outRec['地點']) : ''),
    ]);
  });

  const sh = tSheet_(t, SHEETS.REPORT);
  sh.clear();
  const head = ['日期', '員工編號', '姓名', '部門', '上班', '下班', '工時(小時)', '判定', '地點'];
  sh.getRange(1, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground('#1f3864').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  if (out.length) {
    sh.getRange(2, 1, out.length, head.length).setValues(out);
    for (let i = 0; i < out.length; i++) {
      if (out[i][7] !== '正常') sh.getRange(2 + i, 1, 1, head.length).setBackground('#fdeaea');
    }
  } else {
    sh.getRange(2, 1).setValue(`${ym} 沒有任何打卡紀錄`);
  }
  sh.autoResizeColumns(1, head.length);
  SpreadsheetApp.flush();

  return { rows: out.length, url: t.ss.getUrl() + '#gid=' + sh.getSheetId() };
}

// ─────────────────────────── 月度統計 ───────────────────────────

/**
 * 一個月的出勤統計,月底推播與後台都用這一份。
 * @param {Object} t tenant
 * @param {string} ym 'yyyy/MM'
 */
function tMonthlyStats_(t, ym) {
  const recs = tRead_(t, SHEETS.RECORD).filter(r =>
    r['日期'] instanceof Date && Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM') === ym);

  const leaves = tListLeaves_(t).filter(l =>
    l.status === LEAVE_STATUS.APPROVED && String(l.from).slice(0, 7).replace('-', '/') === ym);

  const emps = tListEmployees_(t).filter(e => e.status === '在職');
  const byEmp = {};
  emps.forEach(e => {
    byEmp[e.code.toUpperCase()] = {
      code: e.code, name: e.name, dept: e.dept,
      days: 0, late: 0, early: 0, missingIn: 0, missingOut: 0,
      hours: 0, leaveDays: 0, unverified: 0,
    };
  });

  // 依「員工|日期」分組,才能判斷缺卡
  const groups = {};
  recs.forEach(r => {
    const code = String(r['員工編號']).trim().toUpperCase();
    const day = Utilities.formatDate(r['日期'], CONFIG.TZ, 'yyyy/MM/dd');
    (groups[code + '|' + day] = groups[code + '|' + day] || []).push(r);
  });

  Object.keys(groups).forEach(key => {
    const code = key.split('|')[0];
    const e = byEmp[code];
    if (!e) return;  // 已離職的人不列入在職統計

    const list = groups[key].sort((a, b) => new Date(a['時間戳記']) - new Date(b['時間戳記']));
    const inRec  = list.filter(r => r['類型'] === PUNCH_IN)[0] || null;
    const outRec = list.filter(r => r['類型'] === PUNCH_OUT).slice(-1)[0] || null;

    e.days++;
    if (!inRec)  e.missingIn++;
    if (!outRec) e.missingOut++;
    if (inRec  && String(inRec['判定']).indexOf('遲到')  === 0) e.late++;
    if (outRec && String(outRec['判定']).indexOf('早退') === 0) e.early++;
    if (inRec && outRec) {
      const ms = new Date(outRec['時間戳記']) - new Date(inRec['時間戳記']);
      if (ms > 0) e.hours += ms / 3600000;
    }
    list.forEach(r => { if (String(r['IP驗證']).indexOf('Worker') < 0 &&
                            String(r['IP驗證']).indexOf('前端') < 0) e.unverified++; });
  });

  leaves.forEach(l => {
    const e = byEmp[String(l.employeeCode).toUpperCase()];
    if (e) e.leaveDays += Number(l.days) || 0;
  });

  const rows = Object.keys(byEmp).map(k => byEmp[k])
    .map(e => Object.assign(e, { hours: Math.round(e.hours * 10) / 10 }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));

  const leaveByType = {};
  leaves.forEach(l => { leaveByType[l.leaveType] = (leaveByType[l.leaveType] || 0) + (Number(l.days) || 0); });

  return {
    ym: ym,
    employees: rows,
    totals: {
      headcount: emps.length,
      manDays:   rows.reduce((s, e) => s + e.days, 0),
      late:      rows.reduce((s, e) => s + e.late, 0),
      early:     rows.reduce((s, e) => s + e.early, 0),
      missing:   rows.reduce((s, e) => s + e.missingIn + e.missingOut, 0),
      hours:     Math.round(rows.reduce((s, e) => s + e.hours, 0) * 10) / 10,
      leaveDays: Math.round(leaves.reduce((s, l) => s + (Number(l.days) || 0), 0) * 10) / 10,
      pendingLeaves: tListLeaves_(t, { status: LEAVE_STATUS.PENDING }).length,
    },
    leaveByType: leaveByType,
    noPunch: emps.filter(e => !byEmp[e.code.toUpperCase()].days).map(e => e.name + '(' + e.code + ')'),
  };
}

/** 把統計整理成聊天室看得懂的訊息 */
function monthlyReportText_(t, stats, sheetUrl) {
  const T = stats.totals;
  const flagged = stats.employees
    .filter(e => e.late || e.early || e.missingIn || e.missingOut)
    .sort((a, b) => (b.late + b.early + b.missingIn + b.missingOut) - (a.late + a.early + a.missingIn + a.missingOut));

  const lines = [];
  lines.push(`📊 <b>${stats.ym} 出勤月報</b>`);
  lines.push(escHtml_(t.name));
  lines.push('');
  lines.push(`在職人數:${T.headcount} 人`);
  lines.push(`出勤合計:${T.manDays} 人日 · ${T.hours} 小時`);
  lines.push(`遲到 ${T.late} 次 · 早退 ${T.early} 次 · 缺卡 ${T.missing} 次`);
  lines.push(`核准請假:${T.leaveDays} 天`);

  const types = Object.keys(stats.leaveByType);
  if (types.length) {
    lines.push('  ' + types.map(k => `${k} ${Math.round(stats.leaveByType[k] * 10) / 10}`).join(' · '));
  }
  if (T.pendingLeaves) lines.push(`⏳ 還有 ${T.pendingLeaves} 筆請假待審核`);

  if (flagged.length) {
    lines.push('');
    lines.push('<b>⚠️ 需要注意</b>');
    flagged.slice(0, 15).forEach(e => {
      const bits = [];
      if (e.late)       bits.push(`遲到${e.late}次`);
      if (e.early)      bits.push(`早退${e.early}次`);
      if (e.missingIn)  bits.push(`缺上班卡${e.missingIn}天`);
      if (e.missingOut) bits.push(`缺下班卡${e.missingOut}天`);
      lines.push(`• ${escHtml_(e.name)} — ${bits.join('、')}`);
    });
    if (flagged.length > 15) lines.push(`  …另有 ${flagged.length - 15} 人`);
  } else {
    lines.push('');
    lines.push('✅ 本月無遲到、早退或缺卡');
  }

  if (stats.noPunch.length) {
    lines.push('');
    lines.push(`<b>整月沒有打卡紀錄(${stats.noPunch.length} 人)</b>`);
    lines.push(stats.noPunch.slice(0, 10).map(escHtml_).join('、') +
               (stats.noPunch.length > 10 ? ' …' : ''));
  }

  if (sheetUrl) {
    lines.push('');
    lines.push(`完整月報:${sheetUrl}`);
  }
  return lines.join('\n');
}

/**
 * 產生月報並推播給該公司的管理員。
 * @return {{ok:boolean, sent:number, message:string}}
 */
function sendMonthlyReport_(companyCode, ym) {
  const t = tenant_(companyCode);
  const month = ym || Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy/MM');

  const built = tBuildMonthlyReport_(t, month);
  const stats = tMonthlyStats_(t, month);
  const text = monthlyReportText_(t, stats, built.url);

  const ids = approverUserIds_(t.code);
  let sent = 0;
  ids.forEach(uid => {
    try { botPushText_(t.code, uid, text); sent++; }
    catch (e) { logEvent_('WARN', 'monthlyReport', `${t.code} 推播 ${uid} 失敗:${e}`); }
  });

  logEvent_('INFO', 'monthlyReport', `${t.code} ${month} 已推播給 ${sent} 位管理員`);
  return { ok: true, sent: sent, message: `${month} 月報已推播給 ${sent} 位管理員`, text: text, url: built.url };
}


// ╔═══ Schedule.gs ═══

/**
 * Schedule.gs — 排程
 *
 * 每天固定時間跑一次 dailyTick(),自己判斷今天是不是當月最後一天;
 * 是的話就對每一家啟用中的公司產生月報並推播給管理員。
 *
 * 用「每天檢查」而不是「每月執行」,是因為 Apps Script 的月觸發器
 * 只能指定 1~28 日,指不到「最後一天」(2月、30日月份都不一樣)。
 *
 * 安裝:在編輯器執行 installTriggers() 一次,或用試算表選單「打卡平台 → 安裝排程」。
 */

const MONTHLY_REPORT_HOUR = 20;  // 月底當天晚上幾點推播(24 小時制)

function installTriggers() {
  // 先清掉舊的,避免重複安裝造成一天推很多次
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (tr.getHandlerFunction() === 'dailyTick') ScriptApp.deleteTrigger(tr);
  });

  ScriptApp.newTrigger('dailyTick')
    .timeBased()
    .atHour(MONTHLY_REPORT_HOUR)
    .everyDays(1)
    .inTimezone(CONFIG.TZ)
    .create();

  const msg = `排程安裝完成。\n每天 ${MONTHLY_REPORT_HOUR}:00 檢查一次,` +
              '當月最後一天會自動產生月報並推播給各公司管理員。';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 非 UI 環境 */ }
  return msg;
}

function removeTriggers() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(tr => {
    if (tr.getHandlerFunction() === 'dailyTick') { ScriptApp.deleteTrigger(tr); n++; }
  });
  return `已移除 ${n} 個排程`;
}

/** 是否為當月最後一天 */
function isLastDayOfMonth_(d) {
  const next = new Date(d.getTime() + 86400000);
  return Utilities.formatDate(next, CONFIG.TZ, 'MM') !==
         Utilities.formatDate(d,    CONFIG.TZ, 'MM');
}

/** 每天被觸發器叫一次 */
function dailyTick() {
  const now = new Date();
  if (!isLastDayOfMonth_(now)) return;
  runMonthEnd_(Utilities.formatDate(now, CONFIG.TZ, 'yyyy/MM'));
}

/**
 * 月底作業:每一家啟用中的公司各產一份月報並推播。
 * 單一公司失敗不影響其他公司。
 */
function runMonthEnd_(ym) {
  const companies = listCompanies_().filter(c => c.status === '啟用');
  const results = [];

  companies.forEach(c => {
    try {
      const r = sendMonthlyReport_(c.code, ym);
      results.push(`${c.code} ✓ ${r.sent} 人`);
    } catch (err) {
      logEvent_('ERROR', 'runMonthEnd', `${c.code}:${err && err.stack ? err.stack : err}`);
      results.push(`${c.code} ✗ ${err}`);
    }
  });

  logEvent_('INFO', 'runMonthEnd', `${ym} 完成:${results.join(' / ')}`);
  return results;
}

/** 手動補跑上個月(月底當天沒跑到時用) */
function runLastMonthEnd() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return runMonthEnd_(Utilities.formatDate(d, CONFIG.TZ, 'yyyy/MM'));
}


// ╔═══ Api.gs ═══

/**
 * Api.gs — Web App 進入點
 *
 * 部署設定必須是:執行身分「我」、誰可以存取「任何人」。
 *
 * 四個進入點(用 p 參數區分):
 *   POST {exec}?p=api                              打卡頁
 *   POST {exec}?p=admin                            管理後台
 *   POST {exec}?p=webhook&c={公司代碼}&token={...}   LINE Webhook
 *   POST {exec}?p=tg&c={公司代碼}&token={...}        Telegram Webhook
 */

function doGet(e) {
  const p = (e && e.parameter && e.parameter.p) || '';
  if (p === 'ping') {
    return json_({ ok: true, service: 'punch-platform', companies: listCompanies_().length, time: new Date().toISOString() });
  }
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<div style="font-family:system-ui;padding:32px;line-height:1.7">' +
    '<h2>打卡平台 API</h2>' +
    '<p>這是後端服務。員工請從 LINE 官方帳號的選單開啟打卡頁;管理員請開啟後台網址。</p>' +
    '<p style="color:#888;font-size:14px">健康檢查:網址後面加 <code>?p=ping</code></p>' +
    '</div>');
}

function doPost(e) {
  try {
    const p = (e && e.parameter && e.parameter.p) || '';
    if (p === 'webhook') return handleWebhookRequest_(e, PLATFORM.LINE);
    if (p === 'tg')      return handleWebhookRequest_(e, PLATFORM.TELEGRAM);
    if (p === 'admin')   return handleAdminRequest_(e);
    return handlePunchRequest_(e);
  } catch (err) {
    logEvent_('ERROR', 'doPost', err && err.stack ? err.stack : err);
    return json_({ ok: false, code: ERR.SERVER, message: '伺服器發生錯誤,請聯絡管理員。' });
  }
}

function parseBody_(e) {
  try {
    return JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return null;
  }
}

// ─────────────────────────── 打卡頁 API ───────────────────────────

function handlePunchRequest_(e) {
  const body = parseBody_(e);
  if (!body) return json_({ ok: false, code: ERR.SERVER, message: '請求格式錯誤' });

  // 啟用 Cloudflare Worker 前置層時,IP 一律以 Worker 判定的為準
  if (CONFIG.trustProxy) {
    if (!CONFIG.proxySecret || body._proxySecret !== CONFIG.proxySecret) {
      return json_({ ok: false, code: ERR.NOT_PROXIED, message: '請求未經授權的通道,已拒絕。' });
    }
    body.ips = body._proxyIp ? [body._proxyIp] : [];
  }

  switch (body.action) {
    case 'config': return json_(handleConfig(body));
    case 'status':       return json_(handleStatus(body));
    case 'punch':        return json_(handlePunch(body));
    case 'leaveInfo':    return json_(handleLeaveInfo(body));
    case 'leaveSubmit':  return json_(handleLeaveSubmit(body));
    case 'leaveCancel':  return json_(handleLeaveCancel(body));
    case 'rules':        return json_(handleRules(body));
    default:       return json_({ ok: false, code: ERR.SERVER, message: '未知的 action:' + body.action });
  }
}

// ─────────────────────────── 後台 API ───────────────────────────

function handleAdminRequest_(e) {
  const body = parseBody_(e);
  if (!body) return json_({ ok: false, code: ERR.SERVER, message: '請求格式錯誤' });
  return json_(handleAdminAction_(body));
}

// ─────────────────────────── LINE Webhook ───────────────────────────

function handleWebhookRequest_(e, platform) {
  // Apps Script 讀不到 HTTP header,所以既驗不了 LINE 的 X-Line-Signature,
  // 也收不到 Telegram 的 secret_token header。兩邊都改用網址上的 token 當共享密鑰。
  const token = (e.parameter && e.parameter.token) || '';
  if (!CONFIG.webhookToken || !safeEqual_(token, CONFIG.webhookToken)) {
    logEvent_('WARN', 'webhook', '收到 token 不符的請求');
    return json_({ ok: false });
  }

  const companyCode = String((e.parameter && e.parameter.c) || '').trim().toUpperCase();
  const co = getCompany_(companyCode);
  if (!co) {
    logEvent_('WARN', 'webhook', '未知的公司代碼:' + companyCode);
    return json_({ ok: false });
  }

  const body = parseBody_(e);
  if (!body) return json_({ ok: true });

  try {
    if (platform === PLATFORM.TELEGRAM) {
      handleTelegramUpdate_(co.code, body);
    } else {
      (body.events || []).forEach(ev => handleLineEvent_(co.code, ev));
    }
  } catch (err) {
    logEvent_('ERROR', 'webhook/' + co.code,
      (err && err.stack ? err.stack : err) + ' | ' + JSON.stringify(body).slice(0, 500));
  }

  return json_({ ok: true });
}

// ─────────────────────────── 共用 ───────────────────────────

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

