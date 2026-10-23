# 台灣舒適度地圖

使用 1991–2020 年資料，比較台灣各鄉鎮歷年平均每年符合自訂氣溫、降雨、估計日照與風速條件的天數。資料來源與方法列於網站頁尾。

## 建置與本機預覽

需要 Node.js 22 或更新版本，建置僅使用標準函式庫：

```powershell
node build_site.cjs
python -m http.server 8766 --bind 127.0.0.1 --directory dist
```

開啟 `http://127.0.0.1:8766/`。`dist` 為獨立部署目錄，只含首頁、圖示、標頭設定與公開資料。請勿上傳整個專案。每次建置會清除並重新產生 `dist`，不改動 `data` 原始檔。

主資料預先 gzip 壓縮，瀏覽器以 `DecompressionStream` 解壓；不支援或解壓失敗時，最多改讀原始主資料一次。資料檔放在內容版本目錄並長期快取；HTML 重新驗證。`.gz` 必須以 `application/gzip` 原樣提供，不能加上 `Content-Encoding: gzip`，否則瀏覽器自動解壓後會再次解壓。`_headers` 適用於 Cloudflare Workers Static Assets；一般本機 HTTP server 不會套用這份設定。

## Cloudflare Workers Static Assets

先執行建置，部署時使用根目錄的 `wrangler.jsonc`，其 `assets.directory` 指向 `dist`。網站為純靜態資產，不需要 Worker 程式、氣候資料重建、API 金鑰或使用者登入。本機建置不會發布。

部署設定使用 Worker `taiwan-comfort-map`，並將 `papple23g.com` 綁為自訂網域。執行部署的帳號必須具有該網域的有效 Cloudflare zone；Wrangler 會建立對應 DNS 與 HTTPS 憑證。

```powershell
npm exec --yes --package=wrangler -- wrangler login
npm exec --yes --package=wrangler -- wrangler whoami
node build_site.cjs
npm exec --yes --package=wrangler -- wrangler deploy
```

以 Wrangler 本機環境檢查靜態資產與 `_headers`：

```powershell
npm exec --yes --package=wrangler -- wrangler dev --local --ip 127.0.0.1 --port 18765
```

開啟 `http://127.0.0.1:18765/`，完成後以 Ctrl+C 停止。

正式 HTTPS 網址需再檢查 gzip 回應沒有 `Content-Encoding`、資料快取標頭、實體手機雙指手勢、系統分享與剪貼簿權限。

## 驗證

```powershell
node --test test_frontend.cjs test_prelaunch.cjs
python -m pytest -q -p no:cacheprovider
```

資料測試只使用本機資料，不會重新下載氣候資料。功能與統計回歸測試不代表氣象估算準確度驗證。

## 分享介面

一般瀏覽不會把條件寫進網址。開啟條件分享連結時，先驗證並還原設定，再清除網址中的條件參數；重新整理乾淨網址即回到預設，不保存上次設定。

「分享我的條件」提供連結分享與圖片分享。選擇連結分享時才產生版本 1 的 `#v=1&…` 連結，網址列保持乾淨；優先使用系統分享，不支援或失敗時改為複製，最後提供可手動複製的網址。取消系統分享不會自動複製。

版本 1 包括鄉鎮、溫度模式與兩組獨立範圍、降雨／估計日照／風速模式與範圍、勾選分區及排序。停用條件的範圍也會保留；`regions=` 表示所有分區均未勾選。進階氣溫保留有限小數。既有分享連結仍可使用；未知版本、非法數值、重複欄位或未知鄉鎮會整組回到預設並提示。網址資料僅解析與驗證，不執行其中內容。

圖片分享使用瀏覽器 Canvas 與現有地圖輪廓，產生 1080×1350 PNG。圖片包含目前鄉鎮、天數、全台分布、條件摘要及資料註記；圖上網址不帶參數，沿用當前部署網域。圖片固定全台視角，不改動使用中的地圖。未選鄉鎮或資料尚無法計算結果時，先處理選擇或資料載入，再製作圖片；條件連結仍可分享。

產圖完成後提供預覽與下載，支援檔案分享的瀏覽器另提供「分享圖片」。圖片以當次開啟分享視窗的條件與結果製作；關閉、重設或重新製作後會丟棄過期工作並釋放預覽資源。系統分享可用性仍需在實際手機及正式 HTTPS 網址驗證。
