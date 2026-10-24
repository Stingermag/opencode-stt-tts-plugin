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

После перезапуска OpenCode плагин будет автоматически загружен.

### Горячие клавиши

| Действие | Горячая клавиша |
|---------|----------------|
| Запись голоса | Ctrl+R |
| Ручное управление (hands-free) | Ctrl+Alt+Space |
| Альтернативное управление | Alt+H |
| Второе управление | Ctrl+Alt+V |

Нажмите горячую клавишу для начала/остановки записи голоса. Текст будет автоматически отправлен в OpenCode после завершения записи.

## Требования

- OpenCode V2
- **Whisper CLI** для распознавания речи
- **Piper TTS** для озвучивания ответов
- **SoX** для обработки аудио
- **Микрофон**

## Дополнительное ПО

Плагин требует следующие внешние утилиты:

### Whisper CLI
1. Скачайте и установите whisper-cli из официального репозитория или через npm:
   ```bash
   npm install -g @openai/whisper-cli
   ```
2. Или используйте бинарник от Microsoft: [whisper.cpp](https://github.com/ggerganov/whisper.cpp)

### Piper TTS
1. Скачайте Piper TTS для Windows из [официального репозитория](https://github.com/rhasspy/piper)
2. Разархивируйте и добавьте исполняемые файлы в PATH

### SoX
Установите SoX для Windows (например, через Chocolatey или Scoop)

## Сеть и VPN

Если используются внешние модели или API (Whisper, LLM), может потребоваться:
- **VPN** для доступа к внешним сервисам (в зависимости от локализации и региона)
- **Прокси** (SOCKS/HTTP) для доступа к моделям Whisper

Настройте прокси в переменных среды, если требуется:

## Лицензия

MIT