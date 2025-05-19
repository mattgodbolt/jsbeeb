# NOTE: We create a temporary Docker container to build the webapp in, then copy
# the generated distributable files to the final Docker image. This keeps the
# final image tidy (since it doesn't contain any generated temporary artifacts),
# and its size to a minimum.
# NOTE: The version of Node must be kept in sync with what's in package.json.
FROM node:22-alpine AS build

# build the webapp
WORKDIR /app/
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

# create the final Docker image
# NOTE: The webapp is just a bunch of static files, so all we need is something to serve them.
FROM nginx:1.27-alpine
COPY docker/nginx-default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /app

EXPOSE 80
CMD [ "nginx", "-g", "daemon off;" ]
