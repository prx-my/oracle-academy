# oracle-academy — headful browser in a container.
#
# Oracle Academy's Akamai edge blocks headless Chromium and login is manual
# Oracle SSO, so the shared browser runs on a virtual X display that you view
# through noVNC (http://localhost:6080/vnc.html).
#
# The Playwright base image ships Chromium + all system deps; keep its tag in
# sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ORACLE_ACADEMY_PROFILE=/data/profile

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify fluxbox supervisor \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

COPY docker/supervisord.conf /etc/supervisor/conf.d/oracle-academy.conf
COPY docker/entrypoint.sh /usr/local/bin/oracle-entrypoint

# Make the CLI available on PATH inside the container.
RUN ln -sf /app/bin/oracle-academy.js /usr/local/bin/oracle-academy \
 && chmod +x /app/bin/oracle-academy.js /usr/local/bin/oracle-entrypoint

VOLUME ["/data"]
EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/oracle-entrypoint"]
