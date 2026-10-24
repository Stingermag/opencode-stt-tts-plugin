# OpenCode Voice Plugin - Dockerfile
# Полностью изолированная среда для голосового плагина

FROM python:3.11-slim

# Установка основных утилит
RUN apt-get update && apt-get install -y \
    sox \
    ffmpeg \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Установка Whisper
RUN pip install --no-cache-dir openai-whisper

# Установка Piper TTS
RUN git clone --recursive https://github.com/rhasspy/piper.git /opt/piper && \
    cd /opt/piper && \
    git checkout v1.2.0 && \
    make && \
    make install

# Копирование плагина
COPY . /opt/opencode-plugin-voice

# Переменные окружения
ENV WHISPER_MODEL="base"
ENV PIPELINES_PATH="/opt/piper/pipelines"
export PYTHONPATH=/opt/piper:$PYTHONPATH

# Команда для запуска
CMD ["python", "/opt/opencode-plugin-voice/index.js"]