# GigaChat Summary Worker

Этот Worker нужен для GitHub Pages: фронтенд вызывает `/api/summarize`, а Worker безопасно ходит в GigaChat.

## 1) Что установить

```bash
npm install -g wrangler
wrangler login
```

## 2) Подготовка

```bash
cd worker
```

## 3) Секреты

Сохраните ключи в секретах Cloudflare (не в коде):

```bash
wrangler secret put GIGACHAT_AUTH_KEY
```

Вставьте ваш `Authorization Key` (строка для `Basic ...` без префикса `Basic`).

При желании:

```bash
wrangler secret put GIGACHAT_SCOPE
wrangler secret put GIGACHAT_MODEL
```

Обычно достаточно дефолтов из `wrangler.toml`.

## 4) Деплой

```bash
wrangler deploy
```

После деплоя получите URL вида:

`https://dreamsite-gigachat-summary.<subdomain>.workers.dev`

## 5) Подключить в news.html

В файле `news/news.html` замените:

```js
const AI_SUMMARY_API_URL = "https://YOUR-WORKER-SUBDOMAIN.workers.dev/api/summarize";
```

на ваш URL Worker + `/api/summarize`.

## 6) Проверка

Откройте страницу новости и нажмите `Пересказать`.

Если Worker отвечает ошибкой, на странице отобразится fallback-пересказ.
