FROM node:18-alpine

# Install git, curl, bash and ripgrep
RUN apk add --no-cache git curl bash ripgrep

RUN git config --global user.email "bunny.sharma@unstop.com" && git config --global user.name "Code Bunny"

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Create directories for repos and logs
RUN mkdir -p repos logs logs/agent

# Expose the API port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
