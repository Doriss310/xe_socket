# Sử dụng image Node.js phiên bản 20
FROM node:20

# Thiết lập thư mục làm việc trong container
WORKDIR /usr/src/app

# Sao chép file package.json và yarn.lock để cài đặt dependencies
COPY package.json yarn.lock ./

# Cài đặt dependencies
RUN yarn install --frozen-lockfile

# Sao chép mã nguồn đến container
COPY . .

# Cài đặt socket.io (nếu cần thiết)
RUN yarn add socket.io

RUN yarn add mysql2

# Mở cổng 3000
EXPOSE 3000

# Lệnh khởi động ứng dụng
CMD ["yarn", "start"]
