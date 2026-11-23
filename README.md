# 家人代購清單

以你提供的原站畫面為參考，重做家人共用的代購流程。家人共用同一份清單。「台灣登記」負責新增與編輯需求，「國外採買」增加採買狀態篩選、拍照和明細上傳。

## 啟動

需要 Node.js 22.13 以上。Windows 可雙擊「啟動家人代購.cmd」，也可以在專案資料夾執行：

```powershell
npm start
```

開啟 [本機清單](http://127.0.0.1:4173)。第一次啟動會在終端印出新產生的家庭通行碼，請保存。終端關閉後，清單伺服器會停止。正式清單一開始是空的，新增需求時可直接輸入人員名稱，之後同一家人可從建議名單選取。

可另外開啟示範資料。示範與正式清單使用各自的資料庫。

```powershell
node server.mjs --demo
```

示範模式的通行碼是 `demo-shopping`。若同時開啟兩個模式，需用不同連接埠。

## 功能

- 新增、編輯或刪除需求，可填數量、整筆金額、幣別、店家、地圖與商品連結、備註。
- 分開顯示待買、有買到、沒買到的數量。國外採買支援狀態篩選和就地更新。
- 條列與詳細模式，拖曳或使用按鈕調整共用順序。
- 商品照片與採買明細分開顯示。可選檔、使用手機相機拍攝，或從剪貼簿貼上。每批最多 10 張，原始檔單張 20 MB、合計 60 MB。瀏覽器會保留比例並縮到最長邊 1080 px 以內。
- 亮暗模式、手機版與安裝到主畫面。安裝需要 HTTPS 或本機網址，更新清單需要連線。
- 點品項名稱可定位到該品項，網址會帶入對應的 `#item-編號`。採買完成可使用 `?saved=status&show=all&view=abroad#item-11` 這類網址顯示儲存訊息並定位；品項編號由這份清單自行產生。

## 家人從其他裝置使用

專案預設只接受同一台電腦的連線。跨裝置共用時，讓同一個伺服器持續執行，並透過 HTTPS 反向代理向家人提供網址。將 `FAMILY_SHOPPING_ORIGIN` 設成對外網址（不帶尾端斜線），例如 `https://shopping.example.com`，再啟動伺服器。若代理在同一台機器，保留預設的本機綁定位址，將代理指向 `http://127.0.0.1:4173`。家人使用同一網址及家庭通行碼。

| 環境變數 | 預設值 |
| --- | --- |
| `FAMILY_SHOPPING_HOST` | `127.0.0.1` |
| `FAMILY_SHOPPING_PORT` | `4173` |
| `FAMILY_SHOPPING_ORIGIN` | 本機 HTTP 位址 |
| `FAMILY_SHOPPING_DB` | 正式模式 `data/shopping.sqlite`，示範模式 `data/demo.sqlite` |

SQLite 資料庫儲存品項、照片、排序和登入狀態。要備份時，先停止伺服器，再複製 `data` 資料夾。要重新產生通行碼，可在專案資料夾執行 `node server.mjs --reset-code`。這會讓既有登入失效，品項與照片會保留。

## 部署到 GitHub Pages

Pages 發布前端。後端請部署在可持續執行 Node.js 22.13 以上的 HTTPS 主機上，並為 SQLite 配置持久磁碟。Pages 用家庭通行碼取得 30 天有效、可撤銷的登入憑證，憑證存在目前瀏覽器分頁的工作階段。

1. 建立前端儲存庫，把專案推送到預設分支（`main` 或 `master`）。在 **Settings → Pages → Source** 選 **GitHub Actions**。
2. 在後端設定 `FAMILY_SHOPPING_ORIGIN` 為後端 HTTPS 來源，`FAMILY_SHOPPING_PAGES_ORIGIN` 為 Pages 的 HTTPS 來源。例如 Pages 網址是 `https://OWNER.github.io/family-shopping/`，後者填 `https://OWNER.github.io`。使用自訂網域時填該網域的來源。
3. 在前端儲存庫的 **Settings → Secrets and variables → Actions → Variables** 新增 `PAGES_API_ORIGIN`，值是後端 HTTPS 來源，例如 `https://api.example.com`。來源包含協定和網域，可包含連接埠，省略路徑與尾端斜線。
4. 在 **Actions** 手動執行 **Deploy GitHub Pages**，或推送到預設分支。成功後，在 **Settings → Pages** 開啟部署網址。

`npm run build:pages` 只把前端檔案包進 `dist-pages/`。未設定 `PAGES_API_ORIGIN` 時，Pages 會顯示後端設定中的畫面。使用預設 GitHub Pages 網域時，同帳號頁面共用同一個瀏覽器來源，請避免讓不受信任的專案共用該來源。

## 將新照片備份到私有 GitHub 儲存庫

1. 另外建立一個**私有**儲存庫，例如 `OWNER/family-shopping-photos`。建立時加入 README，讓它有預設分支。
2. 建立只限該私有儲存庫的 fine-grained 短效權杖，給予 **Contents → Read and write**。在後端主機的機密設定填寫 `FAMILY_SHOPPING_GITHUB_TOKEN`，並設定 `FAMILY_SHOPPING_GITHUB_REPO=OWNER/family-shopping-photos`。前端設定只需要 API 網址。
3. 重啟後端。新商品照片和採買明細會先寫入 SQLite，再送到私有儲存庫的 `photos/<清單識別碼>/<照片編號>.jpg`。短暫失敗會重試，清單會顯示備份進度。

備份檔會留在私有儲存庫，包含清單中後來刪掉的照片。Git 提交歷史也會保留已提交的照片。應讓該儲存庫持續保持私有。啟用前既有的照片留在原本的 SQLite 資料庫。

## 使用 Cloudflare Workers 當後端

這個專案也附有 `wrangler.toml`。Cloudflare Worker 用一個 SQLite 型 Durable Object 保存家人的清單、會話及照片。GitHub Pages 繼續發布前端。自動備份沿用私有的 `a2110560/family-shopping-photos`。Cloudflare Workers Free 支援這個儲存方式，實際用量受 [Cloudflare 免費額度](https://developers.cloudflare.com/durable-objects/platform/pricing/) 限制。

1. 在 Cloudflare **Workers & Pages** 選擇從 GitHub 匯入 `a2110560/family-shopping`。Worker 名稱用 `family-shopping-api`，選預設分支，部署指令用 `npx wrangler@4 deploy`。也可從專案資料夾執行 `npx wrangler@4 login` 和 `npx wrangler@4 deploy`。
2. 在 Worker 的 **Settings → Variables and Secrets** 新增機密 `FAMILY_SHOPPING_CODE`。在自己的終端執行下列指令產生新的家庭通行碼，保存後直接填進 Cloudflare。更換它會使之前的登入失效。家庭成員使用這個通行碼登入，無需 GitHub 或 Cloudflare 帳號。

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
   ```

3. 要啟用照片備份，在同一處新增機密 `FAMILY_SHOPPING_GITHUB_TOKEN`。這個權杖只限上面的私有照片庫，權限為 **Contents → Read and write**。兩個機密都設定在 Cloudflare Worker 執行階段。
4. 開啟 Worker 的 `/health`。回傳 `ok: true` 表示通行碼已設定，`photoBackup: true` 表示已設定備份權杖。用測試照片確認頁面顯示「已備份至 GitHub」，可驗證實際寫入。
5. 將 Worker 的 HTTPS 來源填入前端儲存庫的 Actions 變數 `PAGES_API_ORIGIN`，再執行 **Deploy GitHub Pages**。若前端改用自訂網域，請同步修改 `wrangler.toml` 的 `FAMILY_SHOPPING_PAGES_ORIGIN`。
