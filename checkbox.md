# OpenCode Voice Plugin - Чекбокс для установки

## Установка голосового плагина для OpenCode

### ✅ Требования
- [ ] Установлен OpenCode V2
- [ ] Python 3.10+ (для Whisper)
- [ ] SoX (для аудио обработки)
- [ ] FFmpeg (для конвертации аудио)
- [ ] Микрофон

### Установка ПО

#### Windows
- [ ] Установить Python с https://python.org
- [ ] Установить Whisper через `pip install openai-whisper`
- [ ] Установить Piper TTS
- [ ] Установить SoX

#### Linux
- [ ] Установить Python 3.10+
- [ ] Установить Whisper через `pip3 install openai-whisper`
- [ ] Установить Piper через git
- [ ] Установить SoX через `apt-get install sox`

### Копирование плагина

- [ ] Создать папку `.config/opencode/plugins/voice/`
- [ ] Скопировать файлы плагина в эту папку

### Конфигурация OpenCode

- [ ] Открыть файл `.config/opencode/cli.json`
- [ ] Добавить опции для плагина voice
  - `whisperCli`: путь к whisper-cli
  - `whisperModel`: путь к модели whisper
  - `piper`: путь к исполняемому файлу piper
  - `voice`: путь к модели голоса
  - `sttLanguage`: язык распознавания (например, "ru")
  - `llmEndpoint`: URL LLM (например, "http://localhost:11434/api/generate")
  - `llmModel`: имя модели

### Запуск

- [ ] Перезапустить OpenCode
- [ ] Проверить горячие клавиши:
  - [ ] Ctrl+R - запись голоса
  - [ ] Ctrl+Alt+Space - ручное управление
  - [ ] Alt+H - альтернативное управление
  - [ ] Ctrl+Alt+V - второе управление

### Тестирование

- [ ] Нажать Ctrl+R и сказать "создай файл"
- [ ] Проверить, отправился ли текст в OpenCode
- [ ] Испытать ручное управление

## Дополнительная документация

- [ ] Официальная документация OpenCode
- [ ] Документация Whisper
- [ ] Документация Piper TTS
- [ ] Документация SoX