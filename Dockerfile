# Kestrel 容器镜像：Bun 运行时 + Chromium（headless）+ 中文字体。
#
# 本机默认行为不受影响：不设这些环境变量时，服务仍只监听 127.0.0.1、只放行回环 Host、
# 用本机已装的 Google Chrome 开有头窗口。容器里才切到下面的组合。
#
# 两阶段：依赖只装进 builder，最终镜像只拿 node_modules 成品，
# 避免把 bun 包缓存与安装过程中的临时文件留在镜像层里。

FROM oven/bun:1-debian AS deps
WORKDIR /app
COPY package.json bun.lock ./
# 只装运行期依赖：@types/bun / bun-types 这类纯类型包不进最终镜像
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-debian

ENV DEBIAN_FRONTEND=noninteractive

# chromium：playwright-core 通过 executablePath 启动它（镜像里不下载 Playwright 自带浏览器）
# fonts-noto-cjk：缺了它，右栏预览和截图里的中文全是方块
# git：local_apply_patch 等工具走 git apply，运行时需要
# 安装完在同一个 RUN 里清掉 apt 缓存、文档与 man，这些是纯体积负担
# 国内构建时用 --build-arg APT_MIRROR=mirrors.tencentyun.com 换源；默认仍用 Debian 官方源
ARG APT_MIRROR=deb.debian.org
# 强制 apt 走 IPv4：容器内没有 IPv6 路由，若 DNS 返回 AAAA 记录，apt-get update 会长时间挂住
RUN printf 'Acquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/99force-ipv4 \
 && if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      curl \
      git \
      tini \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
           /usr/share/doc/* /usr/share/man/* /root/.bun/install/cache

WORKDIR /app

# 依赖从 builder 拿成品，不在运行镜像里重新装一遍
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV KESTREL_PORT=18790 \
    KESTREL_HOST=0.0.0.0 \
    KESTREL_DATA=/data \
    KESTREL_HEADLESS=1 \
    KESTREL_CHROME_PATH=/usr/bin/chromium \
    KESTREL_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage --disable-gpu"

RUN mkdir -p /data

VOLUME ["/data"]
EXPOSE 18790

# /health 不受访问口令保护，适合做探活
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${KESTREL_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "run", "service/server.ts"]
