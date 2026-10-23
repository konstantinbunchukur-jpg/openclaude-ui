# Подготовка к GitHub

Репозиторий подготовлен к первой публикации: лицензия MIT, автор коммита задан,
секреты и личные файлы проверены и исключены. Ветка — `main`, первый коммит создан
локально.

Статус кода — **прототип**, не стабильный релиз: известные ограничения и план
исправлений — в [REVIEW.md](REVIEW.md), меры безопасности — в [SECURITY.md](../SECURITY.md),
отчёт о данных — в [SECRETS-AUDIT.md](SECRETS-AUDIT.md).

## Что не попадает в Git

- `config.json`, `.env*` — локальные настройки и ключи.
- `test/demo-workspace/`, `test/fake-config/` — локальные данные ручных проверок.
- `test/run*.json`, `test/s*.txt` — результаты ручных запусков.
- `docs/screenshots/` — скриншоты с реальными путями и именами чатов.
- `*.pem`, `*.key`, `*.p12`, `.npmrc`, `.openclaude*` — секреты и локальное состояние.

Полный список — в `.gitignore`. Автотесты генерируют собственные данные и не зависят
от исключённых папок. `config.example.json` содержит пустое окружение; не копируйте
туда реальные ключи.

Личные документы, которые лежали внутри проекта, вынесены в
`F:\Test\_openclaude-ui-private\` (PDF с персональными данными, скриншоты, логи).
Подробности и рекомендации — в [SECRETS-AUDIT.md](SECRETS-AUDIT.md).

## Первый коммит

Создан локально; хеш покажет `git log -1`. Идентичность задана в конфиге репозитория
(`git config --local user.name` / `user.email`). Если нужно пересоздать с нуля:

```sh
git config --local user.name "Konstantin"
git config --local user.email "konstantinbunchukur@gmail.com"
npm run check
npm test
git add -A
git diff --cached --check
git commit -m "OpenClaude UI: локальный веб-интерфейс для openclaude"
```

Перед коммитом проверьте границы публикации:

```sh
git status --short --ignored
git diff --cached --stat
git grep --cached -nE "sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY"
```

`npm run test:security` проходит (7 из 7). Держите эту проверку в release gate:
её ослабление (`skip`, `todo`, `continue-on-error`) запрещено.

## Публикация

```sh
git remote add origin https://github.com/konstantinbunchukur-jpg/openclaude-ui.git
git push -u origin main
```

Репозиторий создайте пустым — без README, `.gitignore` и LICENSE, иначе первый push
будет отклонён. Безопасный первый шаг — **private** для ревью; в **public**
переключайтесь после перевыпуска скриншотов на синтетических данных.

После публикации:

1. Включите **Secret scanning** и **Push protection** (Settings → Code security).
2. Включите **Private vulnerability reporting** (Settings → Code security).
3. `npm run test:security` зелёный — назначьте job `security` обязательным
   для `main` в Rulesets/branch protection.

GitHub Pages приложение не запустит: ему нужен локальный Node.js и доступ к CLI и
файлам.

## Оформление репозитория

В поле **About** укажите описание «Неофициальный локальный веб-интерфейс для
openclaude CLI» и topics: `openclaude`, `claude`, `cli`, `web-ui`, `local`, `ollama`.

Баннер «forked from» GitHub показывает только у настоящих форков. Это
самостоятельный проект, а не форк `Twigpine/openclaude`: кода upstream в нём нет,
поэтому связь через fork была бы неверной. Совместимость указана в README, About и
topics. Почему не форк — пояснено в README, раздел «Связь с проектом openclaude».

Профиль сообщества GitHub заполнен целиком: README, LICENSE, SECURITY,
CONTRIBUTING, CODE_OF_CONDUCT, шаблоны issue и PR.

## CI и тесты

GitHub Actions запускает проверки на Windows с Node.js 22 и 24: job `smoke`
(`npm run check` и `npm test`) и job `security` (`npm run test:security`); оба
зелёные. Зависимостей нет: `npm install` и lockfile не требуются.
`private: true` в `package.json` предотвращает случайную публикацию в npm и не
влияет на видимость репозитория на GitHub.
