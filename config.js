/**
 * config.js — 三個頁面共用的設定
 *
 * 整個平台只有這個檔案需要改。部署完成後填好這裡,
 * index.html / leave.html / admin.html 都不用動。
 */
window.PUNCH_CONFIG = {

  /**
   * ① 後端網址(必填)
   * Apps Script 部署為網頁應用程式之後拿到的那條,結尾是 /exec。
   * 不要加任何 ?p=... 參數,程式會自己接。
   */
  GAS_URL: 'https://script.google.com/macros/s/請貼上你的部署ID/exec',

  /**
   * ② 後台登入驗證平台:'telegram' 或 'line'
   * 要與 Apps Script 指令碼屬性的 ADMIN_PLATFORM 一致。
   */
  ADMIN_PLATFORM: 'telegram',

  /**
   * ③ 後台專用的 LIFF ID
   * 只有 ADMIN_PLATFORM = 'line' 時才需要填,用 Telegram 就留空。
   */
  ADMIN_LIFF_ID: '',

  /**
   * ④ 選用:Cloudflare Worker 網址(防 IP 偽造)
   * 填了之後打卡與請假會改走 Worker,IP 由連線本身判定,員工無法偽造。
   * 沒架 Worker 就留空。管理後台不受影響,一律直連 Apps Script。
   */
  PROXY_URL: '',
};
