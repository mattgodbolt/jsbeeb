# NOTE: Multi-stage builds require Docker v17.05 or later.

# create the build environment
FROM node:16-alpine AS build

# build the application
WORKDIR /app/
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

# create the final target image
FROM nginx:1.22-alpine
COPY docker/nginx-default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out/dist /app

EXPOSE 80
CMD [ "nginx", "-g", "daemon off;" ]
