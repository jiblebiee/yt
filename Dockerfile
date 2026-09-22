# YT Jukebox — chỉ đóng gói phần SERVER.
#
# Trang /player vẫn chạy bằng Chromium trên desktop của Pi (ngoài container),
# vì nó cần loa và màn hình. Container chỉ phục vụ HTTP + WebSocket.
#
# LƯU Ý: Docker KHÔNG làm server nhẹ đi — tiến trình Node vẫn tốn chừng đó RAM,
# và bạn tốn thêm phần cho dockerd. Cái được là gói sẵn dependency, không cần
# cài npm trên Pi, và nâng cấp/gỡ sạch sẽ.

FROM node:20-alpine

WORKDIR /app

# Cài dependency trước, tách khỏi mã nguồn để tận dụng cache khi chỉ sửa code.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js youtube-api.js ./
COPY public ./public

# Token đăng nhập nằm ở đây — gắn volume để không mất khi dựng lại container.
RUN mkdir -p /app/data && chmod 700 /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# Chạy bằng user không phải root (image node đã có sẵn user "node").
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
