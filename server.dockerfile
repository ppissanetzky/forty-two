FROM node:16.10-slim

# This is where the application lives
WORKDIR /home/node/app

# Make the directory for the site
RUN mkdir ./site
COPY site/dist/ ./site/

# Copy package files into the container
COPY server/package.json server/package-lock.json ./

# This will cause npm to only install production packages
ENV NODE_ENV production

# Turn of the stupid npm update notification
RUN npm config set update-notifier false

# Now, install node modules inside the container
RUN npm ci

# Copy the server code
COPY server/dist/ ./

# Copy the SQL scripts
RUN mkdir ./database
COPY server/database/ ./database/

# Command to start the server
CMD ["node", "server.js"]
