FROM mhart/alpine-node:6.3.1

WORKDIR /app/
COPY ./app/package.json /app/
RUN npm install --production

CMD ["npm", "run"]
