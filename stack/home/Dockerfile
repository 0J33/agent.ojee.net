# haismart-hrdp requires >= 3.11; the HP box's system Python is 3.10, which is exactly why
# this runs in a container rather than on the host.
FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir --upgrade pip

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Vendored rather than pulled from git at build time: the build stays reproducible and the
# image does not need git or network access to a third-party repo.
COPY vendor/haismart_hrdp /app/haismart_hrdp
COPY app /app/app
COPY web /app/web

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    HUB_WEB_DIR=/app/web \
    HUB_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8110

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8110/api/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8110", "--no-access-log"]
