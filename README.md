# 台灣舒適度地圖

[線上使用：台灣舒適度地圖](https://comfort.papple23g.com/)

依自訂氣溫、降雨、估計日照與風速條件，比較台灣各鄉鎮平均每年符合條件的天數。資料涵蓋 **1991–2025 年，預設顯示近 5 年（2021–2025）的平均估算，非即時觀測或天氣預報**；各鄉鎮以代表點估算，資料來源與方法見網站頁尾。

頁首右側的「資料期間」可選近 3 年、近 5 年、近 10 年或全部年份。地圖、排行、每月舒適天數、溫度與雨量統計同步使用所選期間。年份以最新完整資料年 2025 為終點；較短期間容易受個別異常年份影響。

「分享我的條件」提供包含實際年份的條件連結與 PNG 結果圖片，可複製連結、預覽及下載圖片；瀏覽器支援時也可使用系統分享。舊版分享連結仍使用 1991–2020 年期間。一般瀏覽不保存篩選設定。

滑桿拖曳時即時更新讀值，放開後再更新地圖與排行。氣候計算使用 Web Worker，首次建立可重用的位元索引，後續只重算改變的條件；索引約占 19MB 記憶體。瀏覽器不支援或啟動失敗時，改為可中斷的分段計算，避免長時間阻塞操作。

![台灣舒適度地圖操作畫面，頁首提供精簡的資料期間選單](report/year-period-compact-desktop.jpg)

## 建置、預覽與部署

需要 Node.js 22 或更新版本；以下本機預覽指令另需 Python 3：

```powershell
node build_site.cjs
python -m http.server 8766 --bind 127.0.0.1 --directory dist
```

開啟 [本機預覽](http://127.0.0.1:8766/)，以 Ctrl+C 停止伺服器。

網站使用 Cloudflare Workers Static Assets，設定見 `wrangler.jsonc`。以具 `papple23g.com` 網域權限的帳號登入 Wrangler 後，執行：

```powershell
node build_site.cjs
npm exec --yes --package=wrangler -- wrangler deploy
```

每次建置會清除並重新產生 `dist`，不改動 `data` 原始檔。部署僅上傳 `dist`，並保留其中的 `_headers`。`.gz` 須以 `application/gzip` 原樣提供，不得設定 `Content-Encoding: gzip`，以免重複解壓；本機 Python 伺服器不會套用 `_headers`。

網站優先下載 gzip。未壓縮氣候資料超過 Cloudflare 單檔 25 MiB 限制時，建置會將備援資料切成多份；瀏覽器依原順序合併並驗證完整格式。資料內容與計算方式相同。

既有 1991–2020 年資料可用 `python build_comfort_map.py --append-recent-years` 追加至 2025 年。此入口保留既有日期的二進位值與鄉鎮代表點，只下載缺少期間，並在資料驗證與月統計建置成功後替換輸出。原始下載快取存於 `%TEMP%\台灣舒適度地圖\power`。

流量與網頁效能：至 Cloudflare Web Analytics 選擇 `comfort.papple23g.com` 查看。

## 驗證

```powershell
node --test test_frontend.cjs test_compute.cjs test_prelaunch.cjs
python -m pytest -q -p no:cacheprovider
```

資料測試只使用本機資料，不會重新下載氣候資料；通過測試不代表氣象估算準確度已驗證。
