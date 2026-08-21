# src/cloud — Lumina Cloud integration

Эта папка содержит клиентскую часть интеграции Lumina Cloud в desktop-приложении.
Здесь нет секретов или приватных ключей.

- `contracts.cjs` — самодостаточный бандл контрактов API `/v1` (словари рейтингов/статусов,
  формы ответов каталога/загрузки/auth, пути `API_PATHS`, лимиты `UPLOAD_LIMITS`). zod вшит внутрь
  — никаких новых npm-зависимостей. Это сгенерированный файл, вручную не править.
- `contracts.d.ts` — типы для подсказок IDE. Тоже сгенерированный файл.
- `client.js` — тестируемый cloud-клиент: URL/query, auth/anon headers, разбор ошибок,
  каталог, скачивание/добавление, профиль и избранное.
- `capability.js` — чистая логика выбора `unavailable | staging | production`.
- `dev-profile.js` — защита отдельного dev-профиля для `npm run dev:cloud`.
- `oauth.js` — чистые helper-функции Google OAuth/PKCE.

## Обновление контрактов

В репозитории Lumina-Cloud: `npm run build -w packages/contracts`, затем скопировать
`packages/contracts/dist/lumina-contracts.cjs` → `contracts.cjs` и `.d.ts` → `contracts.d.ts`.
Внутри `/v1` бэкенд меняется только аддитивно, так что старый бандл не ломается на новом сервере.

## Не путать

- `contracts.*` обновляются из Lumina-Cloud.
- `client.js`, `capability.js`, `dev-profile.js` и `oauth.js` принадлежат desktop-приложению
  и должны меняться здесь вместе с тестами.
- Backend-документация живёт в репозитории Lumina-Cloud; этот README описывает только сторону
  desktop-клиента.
