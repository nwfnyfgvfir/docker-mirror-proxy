FROM nginx:1.30.8-alpine

ENV NGINX_ENVSUBST_FILTER=^MIRROR_
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
