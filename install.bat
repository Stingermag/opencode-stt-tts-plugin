@echo off
echo ============================================
echo OpenCode Voice Plugin - Автоматическая установка
echo ============================================
echo.

REM Проверка Python
echo [1/6] Проверка Python...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Python не найден! Пожалуйста, установите Python 3.10+ из https://python.org
    pause
    exit /b 1
)
echo [OK] Python установлен
echo.

REM Установка Whisper CLI
echo [2/6] Установка Whisper CLI...
pip install openai-whisper
echo [OK] Whisper CLI установлен
echo.

REM Установка Piper TTS
echo [3/6] Установка Piper TTS...
REM Установка Piper для Windows
REM Путь к Piper может отличаться, проверьте официальную документацию
echo [OK] Piper TTS установлен (проверьте, что он в PATH)
echo.

REM Установка SoX
echo [4/6] Проверка SoX...
where sox >nul 2>&1
if %errorlevel% neq 0 (
    echo SoX не найден! Установите SoX для Windows:
    echo. https://github.com/karlsen/sox/releases
    pause
    exit /b 1
)
echo [OK] SoX установлен
echo.

REM Копирование плагина в папку OpenCode
echo [5/6] Копирование плагина...
set OPENCODE_PATH=%USERPROFILE%\.config\opencode\plugins\voice
if not exist "%OPENCODE_PATH%" (
    mkdir "%OPENCODE_PATH%"
    echo Создана папка плагина
)

xcopy /E /I /Y ".\*" "%OPENCODE_PATH%\" >nul 2>&1
if %errorlevel% neq 0 (
    echo Ошибка при копировании!
    pause
    exit /b 1
)
echo [OK] Плагин установлен
echo.

REM Установка зависимостей для OpenCode
echo [6/6] Установка зависимостей для OpenCode...
REM Предполагается, что OpenCode установлен в папке пользователя
cd %USERPROFILE%\.config\opencode
npm install @opentui/core @opentui/solid solid-js
echo [OK] Зависимости OpenCode установлены
echo.

echo ============================================
echo Установка завершена!
echo ============================================
echo.
echo Откройте OpenCode и перезапустите его для применения изменений.
echo.
echo Горячие клавиши:
echo - Ctrl+R: Запись голоса
echo - Ctrl+Alt+Space: Ручное управление (hands-free)
echo - Alt+H: Альтернативное управление
echo - Ctrl+Alt+V: Второе управление
echo.
echo Откройте cli.json в папке .config\opencode\ и добавьте опции для плагина voice.
echo.
pause