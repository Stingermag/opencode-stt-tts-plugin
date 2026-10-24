# OpenCode Voice Plugin

Голосовой ввод (STT) и озвученные ответы (TTS) для OpenCode на Windows с живым превью.

## Установка

1. **Скопируйте папку** `voice` в папку плагинов OpenCode:
   ```
   C:\Users\<yourusername>\.config\opencode\plugins\voice\
   ```

2. **Установите зависимости** (через npm в корне проекта OpenCode):
   ```bash
   npm install @opentui/core @opentui/solid solid-js
   ```

   Или через yarn:
   ```bash
   yarn add @opentui/core @opentui/solid solid-js
   ```

   Или через pnpm:
   ```bash
   pnpm install @opentui/core @opentui/solid solid-js
   ```

## Настройка

Откройте файл конфигурации OpenCode (`cli.json`) и добавьте опции для плагина:

```json
{
  "voice": {
    "whisperCli": "путь_к_whisper-cli",
    "whisperModel": "путь_к_модели_whisper",
    "piper": "путь_к_piper",
    "voice": "путь_к_модели_голоса",
    "sttLanguage": "ru",
    "llmEndpoint": "http://localhost:11434/api/generate",
    "llmModel": "model_name",
    "micGainDb": 3,
    "autoSubmit": true
  }
}
```

## Запуск

После перезапуска OpenCode плагин будет автоматически загружен. Для активации голосового ввода используйте горячую клавишу (например, Ctrl+R для записи и Ctrl+Alt+Space для ручного управления).

## Требования

- OpenCode V2
- Whisper CLI для распознавания речи
- Piper TTS для озвучивания ответов
- Микрофон

## Лицензия

MIT