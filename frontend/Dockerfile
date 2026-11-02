FROM node:22-alpine AS build
WORKDIR /frontend
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
# The nginx image runs envsubst on /etc/nginx/templates/*.template at startup.
ENV BACKEND_URL=http://backend:5000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
